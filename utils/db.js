const { Pool } = require('pg');
const { OpenAI } = require('openai');

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialize PostgreSQL pool
const pool = new Pool({
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DB,
    password: process.env.POSTGRES_PASSWORD,
    port: process.env.POSTGRES_PORT || 5432,
});

// Initialize pgvector extension
async function initializeVectorExtension() {
    try {
        await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
        console.log('Vector extension initialized');
    } catch (error) {
        console.error('Error initializing vector extension:', error);
        throw error;
    }
}

// Create messages table with vector support
async function createMessagesTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                channel_name TEXT NOT NULL,
                thread_ts TEXT NOT NULL,
                content TEXT NOT NULL,
                user_name TEXT,
                user_title TEXT,
                chunk_index INTEGER,
                metadata JSONB,
                embedding vector(1536),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS messages_embedding_idx ON messages USING ivfflat (embedding vector_cosine_ops);
            CREATE INDEX IF NOT EXISTS messages_channel_thread_idx ON messages(channel_name, thread_ts);
        `);
        console.log('Messages table created with indexes');
    } catch (error) {
        console.error('Error creating messages table:', error);
        throw error;
    }
}

// Helper function to estimate tokens more accurately
function estimateTokens(text) {
    // OpenAI's tokenizer roughly uses 4 characters per token for English text
    return Math.ceil(text.length / 4);
}

// Generate embedding using OpenAI
async function generateEmbedding(text) {
    try {
        const maxTokens = 8192; // Maximum tokens for text-embedding-ada-002
        const estimatedTokens = estimateTokens(text);
        
        if (estimatedTokens > maxTokens) {
            // If text is too long, truncate it to fit within token limit
            const words = text.split(/\s+/);
            let truncatedText = '';
            let currentTokens = 0;
            
            for (const word of words) {
                const wordTokens = estimateTokens(word);
                if (currentTokens + wordTokens > maxTokens) {
                    break;
                }
                truncatedText += word + ' ';
                currentTokens += wordTokens;
            }
            
            text = truncatedText.trim();
        }

        const response = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: text,
            encoding_format: "float"
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error('Error generating embedding:', error);
        throw error;
    }
}

// Function to split text into chunks
function splitIntoChunks(text, maxTokens) {
    // Handle null or undefined text
    if (!text) {
        console.warn('Received null or undefined text in splitIntoChunks');
        return [];  // Return empty array instead of trying to split null
    }

    // Split text into sentences
    const sentences = text.split(/[.!?]+/);
    const chunks = [];
    let currentChunk = '';
    
    for (const sentence of sentences) {
        if (estimateTokens(currentChunk + sentence) > maxTokens) {
            chunks.push(currentChunk.trim());
            currentChunk = sentence;
        } else {
            currentChunk += sentence + '. ';
        }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}

// Store message with embedding and chunking
async function storeMessage(channelName, threadTs, content, userName = null, userTitle = null, chunkIndex = 0, metadata = {}, messageTs = null) {
    try {
        const embedding = await generateEmbedding(content);
        const embeddingArray = `[${embedding.join(',')}]`;
        
        // Convert Slack timestamp to PostgreSQL timestamp
        const messageDate = messageTs ? new Date(parseFloat(messageTs) * 1000) : new Date();
        
        // Check if a message with this thread_ts and chunk_index already exists
        const existingMessage = await pool.query(
            'SELECT id FROM messages WHERE channel_name = $1 AND thread_ts = $2 AND chunk_index = $3',
            [channelName, threadTs, chunkIndex]
        );

        if (existingMessage.rows.length > 0) {
            // Update existing message
            const query = `
                UPDATE messages 
                SET content = $4, user_name = $5, user_title = $6, embedding = $7::vector, 
                    metadata = $8, created_at = $9
                WHERE channel_name = $1 AND thread_ts = $2 AND chunk_index = $3
                RETURNING id;
            `;
            const result = await pool.query(query, [
                channelName, threadTs, chunkIndex, content, userName, userTitle, 
                embeddingArray, metadata, messageDate
            ]);
            console.log('Message updated with ID:', result.rows[0].id);
            return result.rows[0].id;
        } else {
            // Insert new message
            const query = `
                INSERT INTO messages (channel_name, thread_ts, content, user_name, user_title, 
                                    chunk_index, metadata, embedding, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)
                RETURNING id;
            `;
            const result = await pool.query(query, [
                channelName, threadTs, content, userName, userTitle, 
                chunkIndex, metadata, embeddingArray, messageDate
            ]);
            console.log('Message stored with ID:', result.rows[0].id);
            return result.rows[0].id;
        }
    } catch (error) {
        console.error('Error storing message:', error);
        throw error;
    }
}

// Function to chunk and store message
async function chunkAndStoreMessage(channelName, threadTs, content, userName, userTitle, messageTs = null) {
    // Split content into smaller chunks (e.g., 1000 tokens each)
    const chunks = splitIntoChunks(content, 1000);
    
    // Store each chunk with metadata
    for (const chunk of chunks) {
        console.log("Storing chunk : ", chunk);
        await storeMessage(
            channelName,
            threadTs,
            chunk,
            userName,
            userTitle,
            chunks.indexOf(chunk),
            { total_chunks: chunks.length },
            messageTs
        );
    }
}

// Delete all messages for a channel
async function deleteChannelMessages(channelName) {
    try {
        const query = `
            DELETE FROM messages 
            WHERE channel_name = $1
            RETURNING id;
        `;
        
        const result = await pool.query(query, [channelName]);
        console.log(`Deleted ${result.rowCount} messages from channel: ${channelName}`);
        return result.rowCount;
    } catch (error) {
        console.error('Error deleting channel messages:', error);
        throw error;
    }
}

// Improved search function with filters
async function searchSimilarMessages(queryText, limit = 15, minSimilarity = 0.7, filters = {}) {
    try {
        const { channel, user, minDate, maxDate } = filters;
        let whereClause = 'WHERE 1=1';
        const params = [];
        
        if (channel) {
            whereClause += ' AND channel_name = $' + (params.length + 1);
            params.push(channel);
        }
        if (user) {
            whereClause += ' AND user_name = $' + (params.length + 1);
            params.push(user);
        }
        if (minDate) {
            whereClause += ' AND created_at >= $' + (params.length + 1);
            params.push(minDate);
        }
        if (maxDate) {
            whereClause += ' AND created_at <= $' + (params.length + 1);
            params.push(maxDate);
        }
        
        const embedding = await generateEmbedding(queryText);
        params.push(`[${embedding.join(',')}]`, limit);
        
        const sqlQuery = `
            WITH ranked_messages AS (
                SELECT 
                    channel_name,
                    thread_ts,
                    content,
                    user_name,
                    user_title,
                    chunk_index,
                    metadata,
                    1 - (embedding <=> $${params.length - 1}::vector) as similarity,
                    ROW_NUMBER() OVER (PARTITION BY thread_ts ORDER BY 1 - (embedding <=> $${params.length - 1}::vector) DESC) as rank
                FROM messages
                ${whereClause}
                AND 1 - (embedding <=> $${params.length - 1}::vector) > ${minSimilarity}
            )
            SELECT * FROM ranked_messages
            WHERE rank = 1
            ORDER BY similarity DESC
            LIMIT $${params.length};
        `;
        
        const result = await pool.query(sqlQuery, params);
        return result.rows;
    } catch (error) {
        console.error('Error searching similar messages:', error);
        throw error;
    }
}

// Function to get relevant context
async function getRelevantContext(query, maxTokens = 4000) {
    const similarMessages = await searchSimilarMessages(query, 10, 0.7);
    let context = '';
    let currentTokens = 0;
    
    // Sort messages by recency
    similarMessages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    for (const message of similarMessages) {
        let messageContent = message.content;
        
        // Calculate days since the message was created
        const messageDate = new Date(message.created_at);
        const now = new Date();
        const daysSince = Math.floor((now - messageDate) / (1000 * 60 * 60 * 24));
        
        // Construct Slack message link
        const messageLink = `${process.env.SLACK_BASE_URI}/${message.channel_name}/p${message.thread_ts.replace('.', '')}`;
        
        // Check for Notion links in the content
        const notionLinks = messageContent.match(/https:\/\/[^/\s]+\.notion\.so\/[^\s]+/g) || [];
        for (const link of notionLinks) {
            try {
                const { content, summary } = await processLink(link);
                // Replace the link with its summary
                messageContent = messageContent.replace(link, `[${link}]\nSummary: ${summary}`);
            } catch (error) {
                console.error('Error processing Notion link in context:', error);
            }
        }
        
        const messageTokens = estimateTokens(messageContent);
        if (currentTokens + messageTokens > maxTokens) break;
        
        context += `Message from ${message.user_name} (${message.user_title}) ${daysSince} days ago: ${messageContent}\nLink: ${messageLink}\n\n`;
        currentTokens += messageTokens;
    }
    
    return context;
}

// Initialize database
async function initializeDatabase() {
    console.log('Initializing database');
    await initializeVectorExtension();
    await createMessagesTable();
    console.log('Database initialized');
}

module.exports = {
    initializeDatabase,
    storeMessage,
    chunkAndStoreMessage,
    searchSimilarMessages,
    getRelevantContext,
    deleteChannelMessages
}; 