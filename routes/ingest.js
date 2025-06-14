const express = require('express');
const router = express.Router();
const { WebClient } = require('@slack/web-api');
const { extractLinks, processLink, processImage, processPDF } = require('../utils/linkProcessor');
const { storeMessage, searchSimilarMessages, chunkAndStoreMessage, getRelevantContext, generateEmbedding } = require('../utils/db');
const { Anthropic } = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');
const { chromium } = require('playwright');
const { aboutReclaimShort } = require('../utils/contextText');

// Initialize clients
const slack = new WebClient(process.env.SLACK_BOT_OAUTH);
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

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

                // Process any files in the reply
                if (threadMessage.files) {
                    for (const file of threadMessage.files) {
                        try {
                            if (file.mimetype.startsWith('image/')) {
                                const { content, summary } = await processImage(file.url_private_download);
                                threadContent += `
                                    --------------------------------
                                    Image Description: ${summary}
                                    --------------------------------
                                    Full Description: ${content}
                                `;
                            } else if (file.mimetype === 'application/pdf') {
                                const { content, summary } = await processPDF(file.url_private_download);
                                threadContent += `
                                    --------------------------------
                                    PDF Summary: ${summary}
                                    --------------------------------
                                    Full Content: ${content}
                                `;
                            }
                        } catch (error) {
                            console.error(`Error processing file ${file.name}:`, error);
                        }
                    }
                }

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
                                --------------------------------
                                Content : ${content}
                            `;
                        } catch (error) {
                            if (error.message.includes('Google Drive')) {
                                // Post a message to the thread requesting permissions
                                await slack.chat.postMessage({
                                    channel: channelId,
                                    thread_ts: message.thread_ts,
                                    text: "🔒 I don't have access to read this Google Drive file. Please make sure it's shared with `reclaim-ai-bot@reclaim-protocol-c6c62.iam.gserviceaccount.com` with viewer permissions. Once done, please share the link again so that I can learn from it."
                                });
                            }
                            console.error(`Error processing link ${link}:`, error);
                        }
                    }
                }
            }
        }

        let storable = `            
            ${threadContent || message.text}
        `;

        // Process any files in the message
        if (message.files) {
            for (const file of message.files) {
                try {
                    if (file.mimetype.startsWith('image/')) {
                        const { content, summary } = await processImage(file.url_private_download);
                        storable += `
                            --------------------------------
                            Image Description: ${summary}
                            --------------------------------
                            Full Description: ${content}
                        `;
                    } else if (file.mimetype === 'application/pdf') {
                        const { content, summary } = await processPDF(file.url_private_download);
                        storable += `
                            --------------------------------
                            PDF Summary: ${summary}
                            --------------------------------
                            Full Content: ${content}
                        `;
                    }
                } catch (error) {
                    console.error(`Error processing file ${file.name}:`, error);
                }
            }
        }

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
        await chunkAndStoreMessage(channelId, message.thread_ts || message.ts, storable, senderName, senderTitle, message.ts);
    }
}

// Function to process incoming message payload
const processIncomingMessagePayload = async (event, req) => {
    const messageText = event.text;
    const channelId = event.channel;
    const threadTs = event.thread_ts || event.ts;
    const userId = event.user;

    // Get channel info
    const channelInfo = await slack.conversations.info({ channel: channelId });
    const channelName = channelInfo.channel.name;
    const channelDescription = channelInfo.channel.purpose?.value || 'No description';
    const channelTopic = channelInfo.channel.topic?.value || 'No topic';
    const message = {
        text: messageText,
        user: userId,
        thread_ts: threadTs,
        ts: event.ts
    };

    return await processMessageContent(message, channelId, channelName, channelDescription, channelTopic);
};

// Function to format message with blocks
function formatMessageWithBlocks(text) {
    const MAX_BLOCK_TEXT_LENGTH = 3000;
    const blocks = [];
    
    // Split text into sections based on markdown headers
    const sections = text.split(/(?=^|\n)(#{1,6}\s.*$)/m);
    
    for (const section of sections) {
        if (!section.trim()) continue;
        
        // Check if this is a header
        const headerMatch = section.match(/^(#{1,6})\s(.*)$/m);
        if (headerMatch) {
            const level = headerMatch[1].length;
            const content = headerMatch[2].trim();
            blocks.push({
                type: "header",
                text: {
                    type: "plain_text",
                    text: content,
                    emoji: true
                }
            });
            continue;
        }
        
        // Process regular text with markdown
        let processedText = section.trim();
        
        // Convert markdown bold to Slack bold
        processedText = processedText.replace(/\*\*(.*?)\*\*/g, '*$1*');
        
        // Convert markdown italic to Slack italic
        processedText = processedText.replace(/\*(.*?)\*/g, '_$1_');
        
        // Convert markdown code blocks
        processedText = processedText.replace(/```([\s\S]*?)```/g, '```$1```');
        
        // Convert markdown inline code
        processedText = processedText.replace(/`([^`]+)`/g, '`$1`');
        
        // Convert markdown lists
        processedText = processedText.replace(/^\s*[-*+]\s+(.*)$/gm, '• $1');
        
        // Convert markdown links
        processedText = processedText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
        
        // Split long text into chunks that fit within Slack's block text limit
        while (processedText.length > 0) {
            let chunk = processedText;
            if (chunk.length > MAX_BLOCK_TEXT_LENGTH) {
                // Find the last space before the limit
                const lastSpace = chunk.lastIndexOf(' ', MAX_BLOCK_TEXT_LENGTH);
                if (lastSpace === -1) {
                    // If no space found, force split at the limit
                    chunk = chunk.substring(0, MAX_BLOCK_TEXT_LENGTH);
                    processedText = processedText.substring(MAX_BLOCK_TEXT_LENGTH);
                } else {
                    // Split at the last space
                    chunk = chunk.substring(0, lastSpace);
                    processedText = processedText.substring(lastSpace + 1);
                }
            } else {
                processedText = '';
            }
            
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: chunk
                }
            });
        }
    }
    
    return blocks;
}

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
        switch (event.type) {
            case 'member_joined_channel':
            case 'group_joined':
                if (event.user === req.body.authorizations[0].user_id) {
                    // Bot was added to a channel
                    const channelInfo = await slack.conversations.info({ channel: event.channel });
                    
                    // Send welcome message
                    await slack.chat.postMessage({
                        channel: event.channel,
                        blocks: formatMessageWithBlocks("Yay! I'm now in the channel! I will start learning from everything shared in this channel!")
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
                        // Sleep for 1 minute between batches to avoid rate limits
                        await new Promise(resolve => setTimeout(resolve, 60000));
                    } while (cursor && processedCount < 500);

                    console.log(`Processed ${processedCount} historical messages`);
                    await slack.chat.postMessage({
                        channel: event.channel,
                        blocks: formatMessageWithBlocks(`OK! I have learnt all there is to learn from this channel! Ask me anything by tagging me!`)
                    });
                }
                return;

            case 'group_left':
            case 'member_left_channel':
            case 'channel_left':
                await deleteChannelMessages(event.channel);
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
                
                // Process any links in the message
                let linkSummaryText = "";
                const messageLinks = extractLinks(event.text);
                if (messageLinks.length > 0) {
                    linkSummaryText = "Here's a summary of the links in your message:\n\n";
                    for (const link of messageLinks) {
                        try {
                            const { content, summary } = await processLink(link);
                            linkSummaryText += `${link} : \n${summary}\n\n`;
                        } catch (error) {
                            console.error(`Error processing link ${link}:`, error);
                            if (error.message.includes('Google Drive')) {
                                // Post a message to the thread requesting permissions
                                await slack.chat.postMessage({
                                    channel: event.channel,
                                    thread_ts: event.ts,
                                    text: "🔒 I don't have access to read this Google Drive file. Please make sure it's shared with `reclaim-ai-bot@reclaim-protocol-c6c62.iam.gserviceaccount.com` with viewer permissions. Once done, please share the link again so that I can learn from it."
                                });
                            }
                            linkSummaryText += `*${link}*\nSorry, I couldn't process this link.\n\n`;
                        }
                    }
                }
                
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
                        const messageDate = new Date(parseFloat(msg.ts) * 1000);
                        const now = new Date();
                        const daysSince = Math.floor((now - messageDate) / (1000 * 60 * 60 * 24));
                        return `Message from ${userName} (${userTitle}) ${daysSince} days ago: ${msg.text}\n`;
                    } catch (error) {
                        console.error('Error getting user info:', error);
                        return `Message from ${msg.user}: ${msg.text}`;
                    }
                }));

                // Extract Notion links from context and thread text
                const notionLinkRegex = /https:\/\/[^\s<>]*notion\.so\/[^\s<>]*/g;
                const contextNotionLinks = context.match(notionLinkRegex) || [];
                const threadText = threadMessages.join('\n\n');
                const threadNotionLinks = threadText.match(notionLinkRegex) || [];
                const allNotionLinks = [...new Set([...contextNotionLinks, ...threadNotionLinks])];
                const googleSpreadsheetLinkRegex = /https:\/\/[^\s<>]*docs\.google\.com\/spreadsheets\/[^\s<>]*/g;
                const contextGoogleSpreadsheetLinks = context.match(googleSpreadsheetLinkRegex) || [];
                const threadGoogleSpreadsheetLinks = threadText.match(googleSpreadsheetLinkRegex) || [];
                const allGoogleSpreadsheetLinks = [...new Set([...contextGoogleSpreadsheetLinks, ...threadGoogleSpreadsheetLinks])];

                // Get content from Notion links and add to context
                if (allNotionLinks.length > 0) {
                    try {
                        const notionContents = await Promise.all(
                            allNotionLinks.map(async (link) => {
                                try {
                                    const content = await processNotionLink(link);
                                    return `Content from Notion page (${link}):\n${content}`;
                                } catch (error) {
                                    console.error(`Error processing Notion link ${link}:`, error);
                                    return '';
                                }
                            })
                        );
                        const googleSpreadsheetContents = await Promise.all(
                            allGoogleSpreadsheetLinks.map(async (link) => {
                                try {
                                    const content = await processGoogleSpreadsheetLink(link);
                                    return `Content from Google Spreadsheet (${link}):\n${content}`;
                                } catch (error) {
                                    console.error(`Error processing Google Spreadsheet link ${link}:`, error);
                                    return '';
                                }
                            })
                        );

                        // Add non-empty Notion contents to context
                        const validNotionContents = notionContents.filter(content => content);
                        if (validNotionContents.length > 0) {
                            context += '\n\nAdditional context from Notion pages:\n' + validNotionContents.join('\n\n');
                        }
                        const validGoogleSpreadsheetContents = googleSpreadsheetContents.filter(content => content);
                        if (validGoogleSpreadsheetContents.length > 0) {
                            context += '\n\nAdditional context from Google Spreadsheets:\n' + validGoogleSpreadsheetContents.join('\n\n');
                        }
                    } catch (error) {
                        console.error('Error processing Notion links:', error);
                    }
                }

                const fullContext = `
                    You are a helpful assistant that can answer questions about the following context that you may use to answer the question, but also feel free to pull information from other sources including the internet. If you are using information from a link, make sure to include the link in your response.
                    
                    Important: When processing information, pay special attention to the recency of the messages. Information from more recent messages should be given higher priority, and you should explicitly mention if you're using older information that might be outdated.
                    If you are using information from a message link, make sure to include the link in your response.
                    
                    About the company : 
                    ${aboutReclaimShort}
                    
                    Relevant context from the knowledge base (sorted by recency):
                    ${context}
                    
                    Current conversation thread:
                    ${threadText}
                    
                    ${linkSummaryText ? `Links in the current message:\n${linkSummaryText}` : ''}
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

                    // Send response back to Slack thread with formatting
                    await slack.chat.postMessage({
                        channel: event.channel,
                        thread_ts: event.ts,
                        blocks: formatMessageWithBlocks(response.content[0].text)
                    });

                } catch (error) {
                    console.error('Error calling Claude or posting to Slack:', error);
                    await slack.chat.postMessage({
                        channel: event.channel,
                        thread_ts: event.ts,
                        blocks: formatMessageWithBlocks("Sorry, I encountered an error processing your request.")
                    });
                }
                return;

            default:
                console.log("Processing incoming message payload : ", JSON.stringify(event));

                let fileSummaryText = "";
                // Process files in the message
                if (event.files && event.user !== process.env.SLACK_BOT_ID) {
                    fileSummaryText = "Here's a summary of the files in your message:\n\n";
                    
                    for (const file of event.files) {
                        try {
                            if (file.mimetype.startsWith('image/')) {
                                const { content, summary } = await processImage(file.url_private_download);
                                fileSummaryText += `Image: ${file.name}\n${summary}\n\n`;
                            } else if (file.mimetype === 'application/pdf') {
                                const { content, summary } = await processPDF(file.url_private_download);
                                fileSummaryText += `PDF: ${file.name}\n${summary}\n\n`;
                            }
                        } catch (error) {
                            console.error(`Error processing file ${file.name}:`, error);
                            fileSummaryText += `*${file.name}*\nSorry, I couldn't process this file.\n\n`;
                        }
                    }
                }

                // Process links in the message
                let summaryText = "";
                const links = extractLinks(event.text);
                let processedLinks = 0;

                if (links.length > 0 && event.user !== process.env.SLACK_BOT_ID) {
                    summaryText = "Here's a summary of the links in your message:\n\n";
                    
                    for (const link of links) {
                        try {
                            const { content, summary } = await processLink(link);
                            summaryText += `${link} : \n${summary}\n\n`;
                            processedLinks++;
                        } catch (error) {
                            console.error(`Error processing link ${link}:`, error);
                            summaryText += `*${link}*\nSorry, I couldn't process this link.\n\n`;
                        }
                    }
                }
                // If we processed any files or links, respond with notebook emoji
                if (processedLinks == links.length && processedLinks > 0) {
                    try {
                        await slack.reactions.add({
                            channel: event.channel,
                            name: 'notebook',
                            timestamp: event.ts
                        });
                    } catch (error) {
                        console.error('Error adding notebook reaction:', error);
                    }
                }

                console.log("Summary text : ", summaryText);

                event.text = event.text + "\n\n" + summaryText + "\n\n" + fileSummaryText;

                const storable = await processIncomingMessagePayload(event, req);
                if (storable) {  // Only process if we have content to store
                    // Get user info
                    const userInfo = await slack.users.info({ user: event.user });
                    const senderName = userInfo.user ? (userInfo.user.real_name || userInfo.user.name) : event.user;
                    const senderTitle = userInfo.user.profile.title || 'No title';
                    await chunkAndStoreMessage(channelId, threadTs, storable, senderName, senderTitle, event.ts);
                }
        }
    } catch (error) {
        console.error('Error processing Slack message:', error);
    }
});

module.exports = router;

