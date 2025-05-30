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
                embedding vector(1536),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Messages table created');
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

// Store message with embedding
async function storeMessage(channelName, threadTs, content) {
    try {
        const embedding = await generateEmbedding(content);
        
        // Format the embedding array for PostgreSQL
        const embeddingArray = `[${embedding.join(',')}]`;
        
        // Check if a message with this thread_ts already exists
        const existingMessage = await pool.query(
            'SELECT id FROM messages WHERE channel_name = $1 AND thread_ts = $2',
            [channelName, threadTs]
        );

        if (existingMessage.rows.length > 0) {
            // Update existing message
            const query = `
                UPDATE messages 
                SET content = $3, embedding = $4::vector, created_at = CURRENT_TIMESTAMP
                WHERE channel_name = $1 AND thread_ts = $2
                RETURNING id;
            `;
            const result = await pool.query(query, [channelName, threadTs, content, embeddingArray]);
            console.log('Message updated with ID:', result.rows[0].id);
            return result.rows[0].id;
        } else {
            // Insert new message
            const query = `
                INSERT INTO messages (channel_name, thread_ts, content, embedding)
                VALUES ($1, $2, $3, $4::vector)
                RETURNING id;
            `;
            const result = await pool.query(query, [channelName, threadTs, content, embeddingArray]);
            console.log('Message stored with ID:', result.rows[0].id);
            return result.rows[0].id;
        }
    } catch (error) {
        console.error('Error storing message:', error);
        throw error;
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

// Search similar messages
async function searchSimilarMessages(query, limit = 5) {
    try {
        const embedding = await generateEmbedding(query);
        const embeddingArray = `[${embedding.join(',')}]`;
        
        const result = await pool.query(`
            SELECT channel_name, thread_ts, content, 
                   1 - (embedding <=> $1::vector) as similarity
            FROM messages
            ORDER BY embedding <=> $1::vector
            LIMIT $2;
        `, [embeddingArray, limit]);
        
        return result.rows;
    } catch (error) {
        console.error('Error searching similar messages:', error);
        throw error;
    }
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
    searchSimilarMessages,
    deleteChannelMessages
}; 