const express = require('express');
const router = express.Router();
const { WebClient } = require('@slack/web-api');
const { extractLinks, processLink } = require('../utils/linkProcessor');
const { storeMessage, searchSimilarMessages, chunkAndStoreMessage, getRelevantContext } = require('../utils/db');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const { deleteChannelMessages } = require('../utils/db');
const {aboutReclaimShort} = require('../utils/contextText');

// Initialize Slack Web API client
const slack = new WebClient(process.env.SLACK_BOT_OAUTH);

// Shared function to process message content
async function processMessageContent(message, channelId, channelName, channelDescription, channelTopic) {
    try {
        // Skip bot messages
        if (message.user === process.env.SLACK_BOT_ID) {
            return null;
        }
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

                threadContent += `
                    --------------------------------
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

        return storable;
    } catch (error) {
        console.error('Error processing message content:', error);
        return null;
    }
}

// Function to process a single message (for historical messages)
async function processMessage(message, channelId, channelName, channelDescription, channelTopic) {
    const storable = await processMessageContent(message, channelId, channelName, channelDescription, channelTopic);
    if (storable) {
        // Get user info
        const userInfo = await slack.users.info({ user: message.user });
        const senderName = userInfo.user ? (userInfo.user.real_name || userInfo.user.name) : message.user;
        const senderTitle = userInfo.user.profile.title || 'No title';
        await chunkAndStoreMessage(channelId, message.thread_ts || message.ts, storable, senderName, senderTitle);
    }
}

// Function to process incoming message payload
const processIncomingMessagePayload = async (event, req) => {
    const messageText = event.text;
    const channelId = event.channel;
    const threadTs = event.thread_ts || event.ts;
    const userId = event.user;

    // Get channel info
    console.log('Getting channel info...');
    const channelInfo = await slack.conversations.info({ channel: channelId });
    const channelName = channelInfo.channel.name;
    const channelDescription = channelInfo.channel.purpose?.value || 'No description';
    const channelTopic = channelInfo.channel.topic?.value || 'No topic';
    console.log('Channel info:', channelInfo);
    const message = {
        text: messageText,
        user: userId,
        thread_ts: threadTs,
        ts: event.ts
    };

    return await processMessageContent(message, channelId, channelName, channelDescription, channelTopic);
};

// Endpoint to handle Slack messages
router.post('/', async (req, res) => {
    try {
        res.status(200).send('Message received');
        const messageText = req.body.event.text;
        const channelId = req.body.event.channel;
        const threadTs = req.body.event.thread_ts || req.body.event.ts;
        const userId = req.body.event.user;
        const unfurledLinks = req.body.event.links || [];
        

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

        const event = req.body.event;

        console.log('Processing event:', event.type);
        console.log('Event:', messageText.substring(0, 40));
        switch (event.type) {
            case 'member_joined_channel':
            case 'group_joined':
                if (event.user === req.body.authorizations[0].user_id) {
                    // Bot was added to a channel
                    const channelInfo = await slack.conversations.info({ channel: event.channel });
                    
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
                                console.log('Processing message:', message.text.substring(0, 40));
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
                const deleted = await deleteChannelMessages(event.channel);
                console.log(`Deleted ${deleted} messages from channel: ${event.channel}`);
                return;

            case 'app_mention':
                // Add eyes reaction to the message
                await slack.reactions.add({
                    channel: event.channel,
                    name: 'eyes',
                    timestamp: event.ts
                });
                console.log('Processing tagged message...');
                const taggedMessage = await processIncomingMessagePayload(event, req);
                console.log('Tagged message:', taggedMessage.substring(0, 40));
                
                // Get relevant context using the new function
                const context = await getRelevantContext(taggedMessage);
                
                // Get all messages in the thread
                const threadResponse = await slack.conversations.replies({
                    channel: event.channel,
                    ts: event.ts
                });

                // Process thread messages asynchronously
                const threadMessages = await Promise.all(threadResponse.messages.map(async (msg) => {
                    try {
                        const userInfo = await slack.users.info({ user: msg.user });
                        const userName = userInfo.user ? (userInfo.user.real_name || userInfo.user.name) : msg.user;
                        const userTitle = userInfo.user?.profile?.title || 'No title';
                        return `Message from ${userName} (${userTitle}): ${msg.text}`;
                    } catch (error) {
                        console.error('Error getting user info:', error);
                        return `Message from ${msg.user}: ${msg.text}`;
                    }
                }));

                const threadText = threadMessages.join('\n\n');
                const fullContext = `
                    You are a helpful assistant that can answer questions about the following context that you may use to answer the question, but also feel free to pull information from other sources including the internet. If you are using information from a link, make sure to include the link in your response. : 
                    About the company : 
                    ${aboutReclaimShort}
                    
                    Relevant context from the knowledge base:
                    ${context}
                    
                    Current conversation thread:
                    ${threadText}
                `;

                try {
                    // Call Claude API
                    const response = await anthropic.messages.create({
                        model: "claude-sonnet-4-20250514",
                        max_tokens: 1000,
                        system: fullContext,
                        messages: [
                            {
                                role: "user",
                                content: taggedMessage
                            }
                        ]
                    });

                    // Send response back to Slack thread
                    await slack.chat.postMessage({
                        channel: event.channel,
                        thread_ts: event.ts,
                        text: response.content[0].text
                    });

                } catch (error) {
                    console.error('Error calling Claude or posting to Slack:', error);
                    await slack.chat.postMessage({
                        channel: event.channel,
                        thread_ts: event.ts,
                        text: "Sorry, I encountered an error processing your request."
                    });
                }
                return;

            default:
                console.log("Processing incoming message payload : ", JSON.stringify(event));

                // Process links in the message
                let summaryText = "";
                const links = extractLinks(event.text);
                if (links.length > 0 && event.user !== process.env.SLACK_BOT_ID) {
                    summaryText = "Here's a summary of the links in your message:\n\n";
                    
                    for (const link of links) {
                        try {
                            const { content, summary } = await processLink(link);
                            summaryText += `*${link}*\n${summary}\n\n`;
                        } catch (error) {
                            console.error(`Error processing link ${link}:`, error);
                            summaryText += `*${link}*\nSorry, I couldn't process this link.\n\n`;
                        }
                    }

                    // Send the summary as a thread reply
                    await slack.chat.postMessage({
                        channel: event.channel,
                        thread_ts: event.ts,
                        text: summaryText
                    });
                }

                event.text = event.text + "\n\n" + summaryText;

                const storable = await processIncomingMessagePayload(event, req);
                if (storable) {  // Only process if we have content to store
                    // Get user info
                    const userInfo = await slack.users.info({ user: event.user });
                    const senderName = userInfo.user ? (userInfo.user.real_name || userInfo.user.name) : event.user;
                    const senderTitle = userInfo.user.profile.title || 'No title';
                    await chunkAndStoreMessage(channelId, threadTs, storable, senderName, senderTitle);
                }
        }
    } catch (error) {
        console.error('Error processing Slack message:', error);
    }
});

module.exports = router;

