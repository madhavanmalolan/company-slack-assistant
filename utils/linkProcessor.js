const { Client } = require('@notionhq/client');
const { chromium } = require('playwright');
const { google } = require('googleapis');
const { marked } = require('marked');
const cheerio = require('cheerio');
const OpenAI = require('openai');

// Initialize clients
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialize Google Drive client
const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

const drive = google.drive({ version: 'v3', auth });

// Helper function to extract links from text
function extractLinks(text) {
    if(!text) {
        return [];
    }
    const urlRegex = /(https?:\/\/[0-9a-zA-Z\-\.\/]+)/g;
    return text.match(urlRegex) || [];
}

// Process Notion links
async function processNotionLink(url) {
    try {
        const pageId = url.split('-').pop().split('?')[0].replace(">", "").replace("<", "");
        const page = await notion.pages.retrieve({ page_id: pageId });
        const blocks = await notion.blocks.children.list({ block_id: pageId });
        
        let content = '';
        for (const block of blocks.results) {
            if (block.type === 'paragraph') {
                content += block.paragraph.rich_text.map(text => text.plain_text).join('') + '\n';
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
        return content;
    } catch (error) {
        console.error('Error processing Notion link:', error);
        throw error;
    }
}

// Process Google Drive links
async function processGoogleDriveLink(url) {
    try {
        const fileId = url.match(/\/d\/(.*?)(\/|$)/)[1];
        const file = await drive.files.get({ fileId, fields: 'mimeType' });
        
        let content = '';
        switch (file.data.mimeType) {
            case 'application/vnd.google-apps.document':
                const doc = await drive.files.export({ fileId, mimeType: 'text/plain' });
                content = doc.data;
                break;
            case 'application/vnd.google-apps.spreadsheet':
                const sheet = await drive.files.export({ fileId, mimeType: 'text/csv' });
                content = sheet.data;
                break;
            case 'application/vnd.google-apps.presentation':
                const slides = await drive.files.export({ fileId, mimeType: 'text/plain' });
                content = slides.data;
                break;
            default:
                throw new Error('Unsupported Google Drive file type');
        }
        return content;
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
        await page.goto(url, { waitUntil: 'networkidle' });
        
        // Find the section with highest text density
        const content = await page.evaluate(() => {
            // Remove unwanted elements
            const removeSelectors = [
                'script', 'style', 'nav', 'header', 'footer', 
                'aside', 'iframe', 'noscript', 'svg', 'form',
                'button', 'input', 'select', 'textarea'
            ];
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
        return content;
    } catch (error) {
        console.error('Error processing external link:', error);
        throw error;
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

// Main function to process any link
async function processLink(url) {
    try {
        let content;
        
        if (url.includes('notion.so')) {
            content = await processNotionLink(url);
        } else if (url.includes('docs.google.com') || url.includes('drive.google.com')) {
            content = await processGoogleDriveLink(url);
        } else {
            content = await processExternalLink(url);
        }
        const summary = await generateSummary(content);
        return { content, summary };
    } catch (error) {
        console.error('Error processing link:', error);
        throw error;
    }
}

module.exports = {
    extractLinks,
    processLink
}; 