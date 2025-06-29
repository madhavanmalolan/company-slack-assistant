const { Client } = require('@notionhq/client');
const { chromium } = require('playwright');
const { google } = require('googleapis');
const { marked } = require('marked');
const cheerio = require('cheerio');
const OpenAI = require('openai');
const { Anthropic } = require('@anthropic-ai/sdk');
const express = require('express');
const router = express.Router();
const { WebClient } = require('@slack/web-api');
const fetch = require('node-fetch');
const sharp = require('sharp');

// Initialize clients
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const slack = new WebClient(process.env.SLACK_BOT_OAUTH);

// Initialize Google Drive client
const auth = new google.auth.GoogleAuth({
    keyFile: 'google.json',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

const drive = google.drive({ version: 'v3', auth });

// Helper function to extract links from text
function extractLinks(text, attachments) {
    if(!text) {
        return [];
    }
    const urlRegex = /(https?:\/\/[0-9a-zA-Z\-\.\/\_]+)/g;
    return text.match(urlRegex) || [];
}

// Process Notion links
async function processNotionLink(url) {
    try {
        if (!process.env.NOTION_TOKEN) {
            throw new Error('Notion OAuth is not configured');
        }

        const pageId = url.split('-').pop().split('?')[0].replace(">", "").replace("<", "");
        try {
            const page = await notion.pages.retrieve({ page_id: pageId });
            const title = page.properties.title?.title[0]?.plain_text || 'Untitled';
            const blocks = await notion.blocks.children.list({ block_id: pageId });
            
            let content = '';
            for (const block of blocks.results) {
                if (block.type === 'paragraph') {
                    content += block.paragraph.rich_text.map(text => text.plain_text).join('') + '\n';
                } else if (block.type === 'table') {
                    // Get table rows
                    const tableRows = await notion.blocks.children.list({ block_id: block.id });
                    let tableContent = '';
                    let rowCount = 0;
                    
                    // Get header row for context
                    const headerRow = tableRows.results[0];
                    const headers = headerRow.table_row.cells.map(cell => 
                        cell.map(text => text.plain_text).join('')
                    );
                    
                    // Process each row (skip header)
                    for (let i = 1; i < tableRows.results.length; i++) {
                        const row = tableRows.results[i];
                        if (row.type === 'table_row') {
                            const cells = row.table_row.cells.map(cell => 
                                cell.map(text => text.plain_text).join('')
                            );
                            
                            // Create a row object with headers
                            const rowData = {};
                            headers.forEach((header, index) => {
                                rowData[header] = cells[index];
                            });
                            
                            // Generate summary for the row
                            const rowSummary = await anthropic.messages.create({
                                model: "claude-3-5-sonnet-20240620",
                                max_tokens: 100,
                                messages: [{
                                    role: "user",
                                    content: `Using the column titles as context, summarize this table row in one concise sentence. Make sure to reference the column titles in your summary and mention this is from a table in the Notion page:\nPage: ${page.properties.title?.title[0]?.plain_text || 'Untitled'}\nColumns: ${headers.join(', ')}\nRow Data: ${JSON.stringify(rowData, null, 2)}`
                                }]
                            });
                            
                            tableContent += `${rowSummary.content[0].text}\n`;
                            rowCount++;
                        }
                    }
                    
                    // Add table summary
                    content += `[Table with ${rowCount} rows:\n${tableContent}]\n`;
                } else if (block.type === 'child_database') {
                    // Handle database
                    try {
                        const database = await notion.databases.retrieve({ database_id: block.id });
                        const databaseQuery = await notion.databases.query({ database_id: block.id });
                        
                        // Get property names from database schema
                        const propertyNames = Object.keys(database.properties);
                        
                        // Format database content
                        let dbContent = `[Database: ${database.title[0]?.plain_text || 'Untitled'}\n`;
                        dbContent += `Properties: ${propertyNames.join(', ')}\n\n`;
                        
                        // Process each page in the database
                        for (const page of databaseQuery.results) {
                            let pageData = {};
                            for (const propName of propertyNames) {
                                const prop = page.properties[propName];
                                let value = '';
                                
                                // Handle different property types
                                switch (prop.type) {
                                    case 'title':
                                        value = prop.title.map(t => t.plain_text).join('');
                                        break;
                                    case 'rich_text':
                                        value = prop.rich_text.map(t => t.plain_text).join('');
                                        break;
                                    case 'number':
                                        value = prop.number?.toString() || '';
                                        break;
                                    case 'select':
                                        value = prop.select?.name || '';
                                        break;
                                    case 'multi_select':
                                        value = prop.multi_select.map(s => s.name).join(', ');
                                        break;
                                    case 'date':
                                        value = prop.date ? `${prop.date.start}${prop.date.end ? ` to ${prop.date.end}` : ''}` : '';
                                        break;
                                    case 'people':
                                        value = prop.people.map(p => p.name).join(', ');
                                        break;
                                    case 'files':
                                        value = prop.files.map(f => f.name).join(', ');
                                        break;
                                    case 'checkbox':
                                        value = prop.checkbox ? 'Yes' : 'No';
                                        break;
                                    case 'url':
                                        value = prop.url || '';
                                        break;
                                    case 'email':
                                        value = prop.email || '';
                                        break;
                                    case 'phone_number':
                                        value = prop.phone_number || '';
                                        break;
                                    case 'formula':
                                        value = prop.formula?.string || prop.formula?.number?.toString() || '';
                                        break;
                                    case 'relation':
                                        value = prop.relation.map(r => r.id).join(', ');
                                        break;
                                    case 'rollup':
                                        value = prop.rollup?.string || prop.rollup?.number?.toString() || '';
                                        break;
                                    case 'created_time':
                                        value = prop.created_time;
                                        break;
                                    case 'created_by':
                                        value = prop.created_by.name;
                                        break;
                                    case 'last_edited_time':
                                        value = prop.last_edited_time;
                                        break;
                                    case 'last_edited_by':
                                        value = prop.last_edited_by.name;
                                        break;
                                }
                                
                                pageData[propName] = value;
                            }
                            
                            // Generate summary for the database item
                            const itemSummary = await anthropic.messages.create({
                                model: "claude-3-5-sonnet-20240620",
                                max_tokens: 100,
                                messages: [{
                                    role: "user",
                                    content: `Using the property names as context, summarize this database item in one concise sentence. Make sure to reference the property names in your summary and mention this is from a database in the Notion page:\nPage: ${page.properties.title?.title[0]?.plain_text || 'Untitled'}\nProperties: ${propertyNames.join(', ')}\nItem Data: ${JSON.stringify(pageData, null, 2)}`
                                }]
                            });
                            
                            dbContent += `${itemSummary.content[0].text}\n`;
                        }
                        
                        dbContent += `]\n`;
                        content += dbContent;
                    } catch (error) {
                        console.error('Error processing database:', error);
                        content += `[Error processing database: ${error.message}]\n`;
                    }
                } else if (block.type === 'image') {
                    // Process image with OpenAI
                    const imageUrl = block.image.file?.url || block.image.external?.url;
                    if (imageUrl) {
                        const browser = await chromium.launch();
                        const context = await browser.newContext();
                        const page = await context.newPage();
                        await page.goto(imageUrl);
                        // Wait for 3 seconds to ensure image loads
                        await page.waitForTimeout(3000);
                        
                        // Get the image element and convert to base64
                        const base64Image = await page.evaluate(async () => {
                            const img = document.querySelector('img');
                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d');
                            canvas.width = img.width;
                            canvas.height = img.height;
                            ctx.drawImage(img, 0, 0);
                            return canvas.toDataURL('image/jpeg').split(',')[1];
                        });

                        await browser.close();
                        const response = await openai.chat.completions.create({
                            model: "o4-mini",
                            messages: [
                                {
                                    role: "user",
                                    content: [
                                        { type: "text", text: "Describe this image in detail:" },
                                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                                    ]
                                }
                            ],
                        });
                        content += `[Image Description: ${response.choices[0].message.content}]\n`;
                    }
                }
            }
            // Generate summary using Claude
            const summary = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20240620",
                max_tokens: 300,
                messages: [{
                    role: "user",
                    content: `Summarize the key points from this content in a concise paragraph:\n${content}`
                }]
            });

            return {
                content: content,
                summary: summary.content[0].text
            };
        } catch (apiError) {
            if (apiError.code === 'unauthorized' || apiError.message.includes('API token is invalid')) {
                throw new Error('Notion API authentication failed. Please check the API key configuration.');
            } else if (apiError.code === 'object_not_found') {
                throw new Error('The requested Notion page was not found or is not accessible.');
            } else {
                throw new Error(`Notion API error: ${apiError.message}`);
            }
        }
    } catch (error) {
        console.error('Error processing Notion link:', error);
        throw error;
    }
}

// Process Google Drive links
async function processGoogleDriveLink(url) {
    try {
        // Extract file ID from the URL
        const fileId = url.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
        if (!fileId) {
            throw new Error('Could not extract file ID from URL');
        }

        try {
            // Get file metadata
            const file = await drive.files.get({
                fileId: fileId,
                fields: 'name,mimeType',
                supportsAllDrives: true
            });

            let content = '';
            const title = file.data.name;

            // Process based on file type
            switch (file.data.mimeType) {
                case 'application/vnd.google-apps.document':
                    const doc = await drive.files.export({
                        fileId,
                        mimeType: 'text/plain',
                        supportsAllDrives: true
                    });
                    content = doc.data;
                    break;

                case 'application/vnd.google-apps.spreadsheet':
                    const sheet = await drive.files.export({
                        fileId,
                        mimeType: 'text/csv',
                        supportsAllDrives: true
                    });
                    content = sheet.data;
                    break;

                case 'application/vnd.google-apps.presentation':
                    const slides = await drive.files.export({
                        fileId,
                        mimeType: 'text/plain',
                        supportsAllDrives: true
                    });
                    content = slides.data;
                    break;

                default:
                    content = 'Note: This file type cannot be directly exported. Please check the file in Google Drive.';
            }

            // Generate a summary using Claude
            const summary = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20240620",
                max_tokens: 300,
                messages: [{
                    role: "user", 
                    content: `Summarize the key points from this Google Drive content in a concise paragraph:\n${content}`
                }]
            });

            return {
                content: content,
                summary: title + " : " + summary.content[0].text
            };
        } catch (error) {
            // Check for specific permission errors
            if (error.code === 403) {
                if (error.message.includes('insufficientFilePermissions')) {
                    throw new Error('Google Drive Permission denied: You do not have access to this file. Please ensure the file is shared with the appropriate permissions.');
                } else if (error.message.includes('insufficientPermissions')) {
                    throw new Error('Google Drive Permission denied: The service account does not have sufficient permissions to access this file. Please ensure the file is shared with the service account email.');
                } else if (error.message.includes('notFound')) {
                    throw new Error('Google Drive File not found: The requested file does not exist or has been deleted.');
                } else {
                    throw new Error(`Google Drive Permission error: ${error.message}`);
                }
            } else if (error.code === 401) {
                throw new Error('Google Drive Authentication error: The service account credentials are invalid or have expired. Please check your google.json configuration.');
            } else {
                throw new Error(`Google Drive Error: ${error.message}`);
            }
        }
    } catch (error) {
        console.error('Error processing Google Drive link:', error);
        throw error;
    }
}

// Process external website links
async function processExternalLink(url) {
    try {
        const browser = await chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        const title = await page.evaluate(() => {
            return document.querySelector('title').textContent;
        });
        
        try {
            await page.goto(url, { 
                waitUntil: 'networkidle',
                timeout: 30000 // 30 second timeout
            });
        } catch (navigationError) {
            console.error('Navigation error:', navigationError);
            throw new Error(`Failed to load the webpage: ${navigationError.message}`);
        }
        
        // Find the section with highest text density
        const content = await page.evaluate(() => {
            // Remove unwanted elements
            const removeSelectors = [];
            /*[
                'script', 'style', 'nav', 'header', 'footer', 
                'aside', 'iframe', 'noscript', 'svg', 'form',
                'button', 'input', 'select', 'textarea'
            ];*/
            removeSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => el.remove());
            });

            // Function to calculate text score of an element
            function getTextScore(element) {
                const text = element.textContent.trim();
                if (!text) return 0;
                
                const rect = element.getBoundingClientRect();
                const area = rect.width * rect.height;
                if (area === 0) return 0;
                
                // Count words (rough estimate)
                const wordCount = text.split(/\s+/).length;
                
                // Skip sections with less than 50 words
                if (wordCount < 50) return 0;
                
                // Calculate density (words per pixel)
                const density = wordCount / area;
                
                // Calculate length score (logarithmic scale to prevent extremely long texts from dominating)
                const lengthScore = Math.log(wordCount + 1);
                
                // Combine density and length scores
                // We multiply them to favor sections that are both dense and long
                return density * lengthScore;
            }

            // Get all potential content containers
            const containers = Array.from(document.querySelectorAll('div, article, section, main'));
            
            // Find container with highest text score
            let bestContainer = null;
            let highestScore = 0;
            
            containers.forEach(container => {
                const score = getTextScore(container);
                if (score > highestScore) {
                    highestScore = score;
                    bestContainer = container;
                }
            });

            // If no good container found, try the body
            if (!bestContainer || highestScore < 0.0001) {
                bestContainer = document.body;
            }
            // Get the text content
            return bestContainer.textContent.trim();
        });
        
        await browser.close();
        
        if (!content || content.trim().length === 0) {
            throw new Error('No meaningful content found on the webpage');
        }

        // Generate a summary using Claude
        const summary = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 300,
            messages: [{
                role: "user", 
                content: `Summarize the key points from this content in a concise paragraph:\n${content}`
            }]
        });

        return {
            content: content,
            summary: title + " : " + summary.content[0].text
        };
    } catch (error) {
        console.error('Error processing external link:', error);
        throw new Error(`Failed to process external link: ${error.message}`);
    }
}

// Function to limit content to stay within token limits
function limitContent(content) {
    // Rough estimate: 1 word ≈ 1.3 tokens
    // Leave room for system message and other overhead (about 1000 tokens)
    const maxWords = Math.floor((4096 - 1000) / 1.3);
    
    const words = content.split(/\s+/);
    if (words.length <= maxWords) {
        return content;
    }
    return words.slice(0, maxWords).join(' ').replace(/\n/g, '.');
}

// Generate summary using OpenAI
async function generateSummary(content) {
    try {
        // Limit content to stay within token limits
        const limitedContent = limitContent(content);
        
        const response = await openai.chat.completions.create({
            model: "o4-mini",
            messages: [
                {
                    role: "system",
                    content: "You are a helpful assistant that creates concise summaries."
                },
                {
                    role: "user",
                    content: `Please provide a concise 3-4 sentence summary of the following content:\n\n${limitedContent}`
                }
            ],
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error generating summary:', error);
        throw error;
    }
}

// Process image with Claude Vision
async function processImage(url) {
    try {
        // Extract file ID from the URL (format: .../T5UN5PGMT-F0901R23DU6/download/image.png)
        const fileId = url.match(/-([F][A-Z0-9]+)/)?.[1];
        if (!fileId) {
            throw new Error('Could not extract file ID from URL');
        }

        // Download the image using Slack Web API
        const fileResponse = await slack.files.info({
            token: process.env.SLACK_BOT_OAUTH,
            file: fileId
        });

        // Download the file content
        const imageResponse = await fetch(fileResponse.file.url_private_download, {
            headers: {
                'Authorization': `Bearer ${process.env.SLACK_BOT_OAUTH}`
            }
        });
        
        if (!imageResponse.ok) {
            throw new Error(`Failed to download image: ${imageResponse.statusText}`);
        }

        const imageBuffer = await imageResponse.buffer();
        
        // Get the content type from the response
        const contentType = imageResponse.headers.get('content-type');

        let processedImageBuffer;
        try {
            // Try to process the image with sharp
            processedImageBuffer = await sharp(imageBuffer)
                .jpeg() // Convert to JPEG
                .resize(1024, 1024, { // Resize to max dimensions
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .toBuffer();
        } catch (sharpError) {
            // If sharp fails, try to use the original buffer if it's a supported format
            if (contentType && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)) {
                processedImageBuffer = imageBuffer;
            } else {
                throw new Error(`Unsupported image format: ${contentType}`);
            }
        }

        const base64Image = processedImageBuffer.toString('base64');

        // Get image description from Claude
        const claudeResponse = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 300,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Describe this image in detail, focusing on the key elements, context, and any text that appears in it:"
                    },
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: "image/jpeg",
                            data: base64Image
                        }
                    }
                ]
            }]
        });

        const description = claudeResponse.content[0].text;
        // Generate a concise summary using Claude
        const summary = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 100,
            messages: [{
                role: "user",
                content: `Create a concise one-sentence summary of this image description:\n${description}`
            }]
        });
        return {
            content: description,
            summary: summary.content[0].text
        };
    } catch (error) {
        console.error('Error processing image:', error);
        throw error;
    }
}

// Process PDF with OpenAI
async function processPDF(url) {
    try {
        const browser = await chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(url);
        
        // Wait for PDF to load
        await page.waitForTimeout(3000);
        
        // Extract text from PDF
        const text = await page.evaluate(() => {
            return document.body.innerText;
        });

        await browser.close();

        // Generate a summary using Claude
        const summary = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 300,
            messages: [{
                role: "user",
                content: `Summarize the key points from this PDF content in a concise paragraph:\n${text}`
            }]
        });

        return {
            content: text,
            summary: summary.content[0].text
        };
    } catch (error) {
        console.error('Error processing PDF:', error);
        throw error;
    }
}

// Process Granola.ai links
async function processGranolaLink(url) {
    try {
        const browser = await chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        // Navigate to the URL and wait for network idle
        await page.goto(url, { 
            waitUntil: 'networkidle0',
            timeout: 10000 // 10 second timeout
        });
        // Try to get the title first
        let title = 'Untitled';
        try {
            title = await page.evaluate(() => {
                return document.querySelector('title')?.textContent || 'Untitled';
            });
        } catch (titleError) {
            console.warn('Error getting page title:', titleError);
        }
        // Extract the content
        let content = await page.evaluate(() => document.body.innerHTML);
        
        await browser.close();

        if (!content || content.trim().length === 0) {
            throw new Error('No content could be extracted from the Granola.ai page');
        }

        // Generate a summary using Claude
        const summary = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 300,
            messages: [{
                role: "user",
                content: `Summarize the key points from this content in a concise paragraph, remember to make sure you include any action items or next steps:\n${content}`
            }]
        });

        return {
            content: content,
            summary: title + " : " + summary.content[0].text
        };
    } catch (error) {
        console.error('Error processing Granola.ai link:', error);
        throw new Error(`Failed to process Granola.ai link: ${error.message}`);
    }
}

// Process link with enhanced file type detection
async function processLink(url) {
    console.log("Processing link : ", url);
    try {
        if (url.includes('notion.so')) {
            return await processNotionLink(url);
        } else if (url.includes('drive.google.com') || url.includes('docs.google.com')) {
            return await processGoogleDriveLink(url);
        } else if (url.includes('granola.ai')) {
            return await processGranolaLink(url);
        } else {
            return await processExternalLink(url);
        }
    } catch (error) {
        throw error;
    }
}

module.exports = {
    extractLinks,
    processLink,
    processImage,
    processPDF
}; 