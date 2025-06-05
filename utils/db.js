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

// Generate embedding using OpenAI
async function generateEmbedding(text) {
    try {
        const maxTokens = 4096;
        const words = text.split(/\s+/);
        const truncatedText = words.length > maxTokens ? 
            words.slice(0, maxTokens).join(' ') : 
            text;

        const response = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: truncatedText,
            encoding_format: "float"
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error('Error generating embedding:', error);
        throw error;
    }
}

// Helper function to estimate tokens
function estimateTokens(text) {
    // Rough estimate: 1 word ≈ 1.3 tokens
    return Math.ceil(text.split(/\s+/).length * 1.3);
}

// Function to split text into chunks
function splitIntoChunks(text, maxTokens) {
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
async function storeMessage(channelName, threadTs, content, userName = null, userTitle = null, chunkIndex = 0, metadata = {}) {
    try {
        const embedding = await generateEmbedding(content);
        const embeddingArray = `[${embedding.join(',')}]`;
        
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
                    metadata = $8, created_at = CURRENT_TIMESTAMP
                WHERE channel_name = $1 AND thread_ts = $2 AND chunk_index = $3
                RETURNING id;
            `;
            const result = await pool.query(query, [
                channelName, threadTs, chunkIndex, content, userName, userTitle, 
                embeddingArray, metadata
            ]);
            console.log('Message updated with ID:', result.rows[0].id);
            return result.rows[0].id;
        } else {
            // Insert new message
            const query = `
                INSERT INTO messages (channel_name, thread_ts, content, user_name, user_title, 
                                    chunk_index, metadata, embedding)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
                RETURNING id;
            `;
            const result = await pool.query(query, [
                channelName, threadTs, content, userName, userTitle, 
                chunkIndex, metadata, embeddingArray
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
async function chunkAndStoreMessage(channelName, threadTs, content, userName, userTitle) {
    // Split content into smaller chunks (e.g., 1000 tokens each)
    const chunks = splitIntoChunks(content, 1000);
    
    // Store each chunk with metadata
    for (const chunk of chunks) {
        await storeMessage(
            channelName,
            threadTs,
            chunk,
            userName,
            userTitle,
            chunks.indexOf(chunk),
            { total_chunks: chunks.length }
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
async function searchSimilarMessages(queryText, limit = 5, minSimilarity = 0.7, filters = {}) {
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
        params.push(`[${embedding.join(',')}]`, limit, minSimilarity);
        
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
                    1 - (embedding <=> $${params.length - 2}::vector) as similarity,
                    ROW_NUMBER() OVER (PARTITION BY thread_ts ORDER BY 1 - (embedding <=> $${params.length - 2}::vector) DESC) as rank
                FROM messages
                ${whereClause}
                AND 1 - (embedding <=> $${params.length - 2}::vector) > $${params.length - 1}::float
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
    
    for (const message of similarMessages) {
        const messageTokens = estimateTokens(message.content);
        if (currentTokens + messageTokens > maxTokens) break;
        
        context += `Message from ${message.user_name} (${message.user_title}): ${message.content}\n\n`;
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