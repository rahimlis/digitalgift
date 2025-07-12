const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database initialization
async function initializeDB() {
    const maxRetries = 10;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
        try {
            console.log(`🔄 Attempting to connect to database (attempt ${retryCount + 1}/${maxRetries})...`);
            
            await pool.query(`
                CREATE TABLE IF NOT EXISTS gifts (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    message TEXT NOT NULL,
                    recipient VARCHAR(255) NOT NULL,
                    drive_link TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    views INTEGER DEFAULT 0,
                    is_active BOOLEAN DEFAULT TRUE
                );
            `);
            
            // Create index for better performance
            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_gifts_created_at ON gifts(created_at DESC);
            `);
            
            console.log('✅ Database initialized successfully');
            return true;
        } catch (error) {
            retryCount++;
            console.error(`❌ Error initializing database (attempt ${retryCount}/${maxRetries}):`, error.message);
            
            if (retryCount >= maxRetries) {
                console.error('❌ Max database connection retries exceeded. Server will start but database operations may fail.');
                return false;
            }
            
            // Wait before retrying (exponential backoff)
            const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
            console.log(`⏳ Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return false;
}

// Helper function to convert Google Drive share link to direct download
function convertToDirectLink(link) {
    const fileId = link.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (fileId) {
        return `https://drive.google.com/uc?export=download&id=${fileId[1]}`;
    }
    return link;
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create a new gift
app.post('/api/gifts', async (req, res) => {
    try {
        const { message, recipient, driveLink } = req.body;
        
        if (!message || !recipient || !driveLink) {
            return res.status(400).json({ 
                error: 'Missing required fields: message, recipient, driveLink' 
            });
        }

        // Validate Google Drive link
        if (!driveLink.includes('drive.google.com')) {
            return res.status(400).json({ 
                error: 'Invalid Google Drive link' 
            });
        }

        const giftId = uuidv4();
        const directLink = convertToDirectLink(driveLink);
        
        const query = `
            INSERT INTO gifts (id, message, recipient, drive_link, created_at, updated_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING *;
        `;
        
        const result = await pool.query(query, [giftId, message, recipient, directLink]);
        const gift = result.rows[0];

        res.json({
            success: true,
            giftId: gift.id,
            shareUrl: `${req.protocol}://${req.get('host')}/gift/${gift.id}`
        });
    } catch (error) {
        console.error('Error creating gift:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get gift by ID
app.get('/api/gifts/:id', async (req, res) => {
    try {
        const giftId = req.params.id;
        
        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(giftId)) {
            return res.status(400).json({ error: 'Invalid gift ID format' });
        }

        const selectQuery = `
            SELECT id, message, recipient, drive_link, created_at, views, is_active
            FROM gifts 
            WHERE id = $1 AND is_active = TRUE;
        `;
        
        const result = await pool.query(selectQuery, [giftId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Gift not found or has been deactivated' });
        }

        const gift = result.rows[0];
        
        // Increment view count
        const updateQuery = `
            UPDATE gifts 
            SET views = views + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1;
        `;
        
        await pool.query(updateQuery, [giftId]);

        // Return gift data with camelCase keys
        res.json({
            id: gift.id,
            message: gift.message,
            recipient: gift.recipient,
            driveLink: gift.drive_link,
            createdAt: gift.created_at,
            views: gift.views + 1 // Include the new view count
        });
    } catch (error) {
        console.error('Error fetching gift:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get gift statistics (for analytics)
app.get('/api/gifts/:id/stats', async (req, res) => {
    try {
        const giftId = req.params.id;
        
        const query = `
            SELECT id, views, created_at, updated_at
            FROM gifts 
            WHERE id = $1 AND is_active = TRUE;
        `;
        
        const result = await pool.query(query, [giftId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Gift not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching gift stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Deactivate gift (soft delete)
app.delete('/api/gifts/:id', async (req, res) => {
    try {
        const giftId = req.params.id;
        
        const query = `
            UPDATE gifts 
            SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1 AND is_active = TRUE
            RETURNING id;
        `;
        
        const result = await pool.query(query, [giftId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Gift not found' });
        }

        res.json({ 
            success: true, 
            message: 'Gift deactivated successfully' 
        });
    } catch (error) {
        console.error('Error deactivating gift:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get recent gifts (for admin/analytics - limit to recent ones)
app.get('/api/gifts', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const offset = parseInt(req.query.offset) || 0;
        
        const query = `
            SELECT id, message, recipient, created_at, views, is_active
            FROM gifts 
            WHERE is_active = TRUE
            ORDER BY created_at DESC 
            LIMIT $1 OFFSET $2;
        `;
        
        const result = await pool.query(query, [limit, offset]);
        
        // Also get total count
        const countQuery = `SELECT COUNT(*) FROM gifts WHERE is_active = TRUE;`;
        const countResult = await pool.query(countQuery);
        
        res.json({
            gifts: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit,
            offset
        });
    } catch (error) {
        console.error('Error fetching gifts:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Clean up old gifts (run periodically)
app.post('/api/admin/cleanup', async (req, res) => {
    try {
        // Delete gifts older than 30 days with 0 views
        const query = `
            DELETE FROM gifts 
            WHERE created_at < NOW() - INTERVAL '30 days' 
            AND views = 0;
        `;
        
        const result = await pool.query(query);
        
        res.json({ 
            success: true, 
            deletedCount: result.rowCount,
            message: `Cleaned up ${result.rowCount} old unused gifts`
        });
    } catch (error) {
        console.error('Error cleaning up gifts:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Serve gift page
app.get('/gift/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check with database connection test
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            database: 'connected'
        });
    } catch (error) {
        res.status(503).json({ 
            status: 'ERROR', 
            timestamp: new Date().toISOString(),
            database: 'disconnected',
            error: error.message
        });
    }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully');
    await pool.end();
    process.exit(0);
});

// Initialize database and start server
initializeDB().then((dbInitialized) => {
    app.listen(PORT, () => {
        console.log(`🎁 PDF Gift Server running on port ${PORT}`);
        console.log(`🌐 Access your app at: http://localhost:${PORT}`);
        console.log(`🗄️  Database: ${dbInitialized ? 'Connected' : 'Connection Issues - Retrying in background'}`);
        
        // If database failed to initialize, try again in background
        if (!dbInitialized) {
            setTimeout(() => {
                console.log('🔄 Retrying database initialization in background...');
                initializeDB();
            }, 5000);
        }
    });
}).catch((error) => {
    console.error('❌ Failed to initialize server:', error);
    // Start server anyway
    app.listen(PORT, () => {
        console.log(`🎁 PDF Gift Server running on port ${PORT} (Database connection pending)`);
        console.log(`🌐 Access your app at: http://localhost:${PORT}`);
        console.log(`⚠️  Database: Connection failed - Some features may not work`);
    });
});

module.exports = app;   