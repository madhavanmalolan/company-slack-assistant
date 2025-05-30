const express = require('express');
const router = express.Router();
const { WebClient } = require('@slack/web-api');
const { extractLinks, processLink } = require('../utils/linkProcessor');
const { storeMessage, searchSimilarMessages } = require('../utils/db');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const { deleteChannelMessages } = require('../utils/db');
const {aboutReclaimShort} = require('../utils/contextText');

// Initialize Slack Web API client
const slack = new WebClient(process.env.SLACK_BOT_OAUTH);

// Function to process a single message
async function processMessage(message, channelId, channelName, channelDescription, channelTopic) {
    try {
        // Skip bot messages
        if (message.user === process.env.SLACK_BOT_ID) {
            return;
        }

        // Get user info
        const userInfo = await slack.users.info({ user: message.user });
        const senderName = userInfo.user.real_name || userInfo.user.name;
        const senderTitle = userInfo.user.profile.title || 'No title';

        // Get thread info if it exists
        let threadContent = '';
        if (message.thread_ts) {
            const threadResponse = await slack.conversations.replies({
                channel: channelId,
                ts: message.thread_ts
            });

            // Process all messages in the thread
            for (const threadMessage of threadResponse.messages) {
                // Skip bot messages
                if (threadMessage.user === process.env.SLACK_BOT_ID) {
                    continue;
                }

                // Get user info for each message
                const threadUserInfo = await slack.users.info({ user: threadMessage.user });
                const threadSenderName = threadUserInfo.user.real_name || threadUserInfo.user.name;
                const threadSenderTitle = threadUserInfo.user.profile.title || 'No title';

                // Check for URL unfurls in the message
                if (threadMessage.attachments) {
                    for (const attachment of threadMessage.attachments) {
                        if (attachment.is_url_unfurl) {
                            threadContent += `
                                --------------------------------
                                URL Preview:
                                Title: ${attachment.title || ''}
                                Text: ${attachment.text || ''}
                                Description: ${attachment.fallback || ''}
                            `;
                        }
                    }
                }


                threadContent += `
                    --------------------------------
                    ${threadContent ? 'Reply from' : 'Message from'}: ${threadSenderName}
                    Title: ${threadSenderTitle}
                    
                    ${threadMessage.text}
                `;

                // Process any links in the reply
                const replyLinks = extractLinks(threadMessage.text);
                if (replyLinks.length > 0) {
                    for (const link of replyLinks) {
                        try {
                            const { content, summary } = await processLink(link);
                            threadContent += `
                                --------------------------------
                                Contents of Link : ${link}
                                --------------------------------
                                Summary : ${summary}
                                Content : ${content}
                            `;
                        } catch (error) {
                            console.error(`Error processing link ${link}:`, error);
                        }
                    }
                }
            }
        }

        let storable = `
            Sender : ${senderName}
            Title : ${senderTitle}
            Channel : ${channelName}
            Channel Description : ${channelDescription}
            Channel Topic : ${channelTopic}
            
            ${threadContent || message.text}
        `;

        // Process any links in the message
        const links = extractLinks(message.text);
        if (links.length > 0) {
            for (const link of links) {
                try {
                    const { content, summary } = await processLink(link);
                    storable += `
                        --------------------------------
                        Contents of Link : ${link}
                        --------------------------------
                        Summary : ${summary}
                        Content : ${content}
                    `;
                } catch (error) {
                    console.error(`Error processing link ${link}:`, error);
                }
            }
        }

        console.log("Storing message : ", storable);

        await storeMessage(channelId, message.thread_ts || message.ts, storable);
        return storable;
    } catch (error) {
        console.error('Error processing historical message:', error);
    }
}

const processIncomingMessagePayload = async (event, req) => {
    console.log('Unhandled event type:', event.type);
    const messageText = req.body.event.text;
    const channelId = req.body.event.channel;
    const threadTs = req.body.event.thread_ts || req.body.event.ts;
    const userId = req.body.event.user;

    // Get user info
    const userInfo = await slack.users.info({ user: userId });
    const senderName = userInfo.user ? (userInfo.user.real_name || userInfo.user.name) : userId;
    const senderTitle = userInfo.user.profile.title || 'No title';
    const senderEmail = userInfo.user.profile.email;

    // Get channel info
    const channelInfo = await slack.conversations.info({ channel: channelId });
    const channelName = channelInfo.channel.name;
    const channelDescription = channelInfo.channel.purpose?.value || 'No description';
    const channelTopic = channelInfo.channel.topic?.value || 'No topic';

    // Get thread info if it exists
    let threadContent = '';
    if (threadTs !== req.body.event.ts) {
        const threadResponse = await slack.conversations.replies({
            channel: channelId,
            ts: threadTs
        });
        
        // Process all messages in the thread
        for (const message of threadResponse.messages) {
            // Skip bot messages
            if (message.user === req.body.authorizations[0].user_id) {
                continue;
            }
            
            // Get user info for each message
            const threadUserInfo = await slack.users.info({ user: message.user });
            const threadSenderName = threadUserInfo.user.real_name || threadUserInfo.user.name;
            const threadSenderTitle = threadUserInfo.user.profile.title || 'No title';
            
            threadContent += `                            --------------------------------
                ${threadContent ? 'Reply from' : 'Message from'}: ${threadSenderName}
                Title: ${threadSenderTitle}
                
                ${message.text}
            `;
            

            // Check for URL unfurls in the message
            if (message.attachments) {
                for (const attachment of message.attachments) {
                    if (attachment.is_url_unfurl) {
                        threadContent += `
                            --------------------------------
                            URL Preview:
                            Title: ${attachment.title || ''}
                            Text: ${attachment.text || ''}
                            Description: ${attachment.fallback || ''}
                        `;
                    }
                }
            }
            

            // Process any links in the reply
            const replyLinks = extractLinks(message.text);
            if (replyLinks.length > 0) {
                for (const link of replyLinks) {
                    try {
                        const { content, summary } = await processLink(link);
                        threadContent += `
                            --------------------------------
                            Contents of Link : ${link}
                            --------------------------------
                            Summary : ${summary}
                            Content : ${content}
                        `;
                    } catch (error) {
                        console.error(`Error processing link ${link}:`, error);
                    }
                }
            }
        }
    }

    let storable = `
        Sender : ${senderName}
        Title : ${senderTitle}
        Channel : ${channelName}
        Channel Description : ${channelDescription}
        Channel Topic : ${channelTopic}
        
        ${threadContent || messageText}
    `;

    // Process any links in the message
    const links = extractLinks(messageText);
    if (links.length > 0) {
        for (const link of links) {
            try {
                const { content, summary } = await processLink(link);
                storable += `
                    --------------------------------
                    Contents of Link : ${link}
                    --------------------------------
                    Summary : ${summary}
                    Content : ${content}
                `;
            } catch (error) {
                console.error(`Error processing link ${link}:`, error);
            }
        }
    }
    return storable;
}

// Endpoint to handle Slack messages
router.post('/', async (req, res) => {
    try {
        res.status(200).send('Message received');
        const messageText = req.body.event.text;
        const channelId = req.body.event.channel;
        const threadTs = req.body.event.thread_ts || req.body.event.ts;
        const userId = req.body.event.user;
    
        // Get user info
        const userInfo = await slack.users.info({ user: userId });
        const senderName = userInfo.user.real_name || userInfo.user.name;
        const senderTitle = userInfo.user.profile.title || 'No title';
        const senderEmail = userInfo.user.profile.email;
    
        // Get channel info
        const channelInfo = await slack.conversations.info({ channel: channelId });
        const channelName = channelInfo.channel.name;
        const channelDescription = channelInfo.channel.purpose?.value || 'No description';
        const channelTopic = channelInfo.channel.topic?.value || 'No topic';
    
        
        const event = req.body.event;

        switch (event.type) {
            case 'member_joined_channel':
            case 'group_joined':
                if (event.user === req.body.authorizations[0].user_id) {
                    // Bot was added to a channel
                    const channelInfo = await slack.conversations.info({ channel: event.channel });
                    console.log(`Bot was added to channel: ${channelInfo.channel.name}`);
                    
                    // Send welcome message
                    await slack.chat.postMessage({
                        channel: event.channel,
                        text: `Yay! I'm now in the channel! I will start learning from everything shared in this channel!`
                    });

                    // Process historical messages
                    console.log('Processing historical messages...');
                    let cursor;
                    let processedCount = 0;
                    
                    do {
                        const result = await slack.conversations.history({
                            channel: event.channel,
                            limit: 100,
                            cursor: cursor
                        });

                        for (const message of result.messages) {
                            try {
                                console.log('Processing message:', message.text);
                                await processMessage(
                                    message,
                                    event.channel,
                                    channelInfo.channel.name,
                                    channelInfo.channel.purpose?.value || 'No description',
                                    channelInfo.channel.topic?.value || 'No topic'
                                );                                    
                            } catch (error) {
                                console.error('Error processing message:', error);
                            }
                            processedCount++;
                        }

                        cursor = result.response_metadata?.next_cursor;
                    } while (cursor && processedCount < 500);

                    console.log(`Processed ${processedCount} historical messages`);
                    await slack.chat.postMessage({
                        channel: event.channel,
                        text: `OK! I have learnt all there is to learn from this channel! Ask me anything by tagging me!`
                    });


                }
                return;

            case 'group_left':
            case 'member_left_channel':
            case 'channel_left':
                console.log('Bot was removed from channel:', event.channel);
                const deleted = await deleteChannelMessages(event.channel);
                console.log(`Deleted ${deleted} messages from channel: ${event.channel}`);
                return;

            case 'app_mention':
                console.log('Bot was mentioned in channel:', event.channel);
                // Add eyes emoji reaction to show the bot is processing
                await slack.reactions.add({
                    channel: event.channel,
                    timestamp: event.ts,
                    name: 'eyes'
                });
                const taggedMessage = await processIncomingMessagePayload(event, req);
                const similarMessages = await searchSimilarMessages(taggedMessage, 20);
                // Get all messages in the thread
                const threadResponse = await slack.conversations.replies({
                    channel: event.channel,
                    ts: event.ts
                });

                const relevantMessages = similarMessages.filter(message => message.similarity > 0.9);
                // Extract just the message text from each reply
                const threadText = threadResponse.messages
                    .map(msg => `Message from ${slack.users.info({ user: msg.user }).user? (slack.users.info({ user: msg.user }).user.real_name || slack.users.info({ user: msg.user }).user.name) : msg.user} : ${msg.text}`)
                    .join('\n\n');
                const context = `
                    You are a helpful assistant that can answer questions about the following context that you may use to answer the question, but also feel free to pull informatoin from other soruces including the internet : 
                    About the company : 
                    ${aboutReclaimShort}
                    Below are some of the most similar messages that you may use to answer the question : 
                    ${relevantMessages.map(message => message.content).join('\n')}
                `;
                try {
                    // Call Claude API
                    const response = await anthropic.messages.create({
                        model: "claude-sonnet-4-20250514",
                        max_tokens: 1000,
                        system: context,
                        //todo tools
                        messages: [
                            {
                                role: "user",
                                content: `${threadText}`
                            }
                        ]
                    });

                    // Send response back to Slack thread
                    await slack.chat.postMessage({
                        channel: event.channel,
                        thread_ts: event.ts,
                        text: `${response.content[0].text}
                        `
                    });

                } catch (error) {
                    console.error('Error calling Claude or posting to Slack:', error);
                    
                    // Send error message to thread
                    await slack.chat.postMessage({
                        channel: event.channel,
                        thread_ts: event.ts,
                        text: "Sorry, I encountered an error processing your request."
                    });
                }
                return;

            default:
                const storable = await processIncomingMessagePayload(event, req);
                await storeMessage(channelId, threadTs, storable);        
        }
    } catch (error) {
        console.error('Error processing Slack message:', error);
    }
});

module.exports = router;

