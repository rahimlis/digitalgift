const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function setupDatabase() {
    try {
        console.log('🔧 Setting up database...');
        
        // Create the gifts table
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
        
        // Create indexes for better performance
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_gifts_created_at ON gifts(created_at DESC);
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_gifts_active ON gifts(is_active) WHERE is_active = TRUE;
        `);
        
        // Add a function to automatically update updated_at timestamp
        await pool.query(`
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ language 'plpgsql';
        `);
        
        // Create trigger to automatically update updated_at
        await pool.query(`
            DROP TRIGGER IF EXISTS update_gifts_updated_at ON gifts;
            CREATE TRIGGER update_gifts_updated_at
                BEFORE UPDATE ON gifts
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column();
        `);
        
        console.log('✅ Database setup completed successfully!');
        
        // Test the setup with a sample query
        const testResult = await pool.query('SELECT COUNT(*) FROM gifts;');
        console.log(`📊 Current gifts count: ${testResult.rows[0].count}`);
        
    } catch (error) {
        console.error('❌ Error setting up database:', error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

setupDatabase();