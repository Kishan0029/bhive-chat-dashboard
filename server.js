require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Supabase client ────────────────────────────────────────────────────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// ── In-memory store (rebuilt from DB on startup) ───────────────────────────
const conversations = {};
let msgSeq = 0;

// Load all past messages from Supabase into memory on startup
async function loadConversations() {
    try {
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .order('seq', { ascending: true });

        if (error) throw error;

        data.forEach(row => {
            if (!conversations[row.phone]) {
                conversations[row.phone] = { contactName: row.contact_name, messages: [] };
            }
            conversations[row.phone].messages.push({
                type:      row.type,
                text:      row.text,
                timestamp: row.timestamp,
                seq:       row.seq
            });
            // Keep msgSeq in sync with highest stored seq
            if (row.seq > msgSeq) msgSeq = Math.floor(row.seq);
        });

        console.log(`✅ Loaded ${data.length} messages from Supabase`);
    } catch (err) {
        console.error('⚠️  Could not load from Supabase (continuing with empty state):', err.message);
    }
}

// Save a single message to Supabase
async function saveMessage(phone, contactName, message) {
    try {
        const { error } = await supabase.from('messages').insert({
            phone,
            contact_name: contactName,
            type:         message.type,
            text:         message.text,
            timestamp:    message.timestamp,
            seq:          message.seq
        });
        if (error) console.error('⚠️  Supabase insert error:', error.message);
    } catch (err) {
        console.error('⚠️  Supabase save failed:', err.message);
    }
}

// Serve index.html from root directory
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Endpoint 1: n8n sends incoming WhatsApp messages here ──────────────────
app.post('/webhook/incoming', async (req, res) => {
    console.log('🔥 INCOMING:', req.body);
    const { from, text, contactName } = req.body;

    if (!conversations[from]) {
        conversations[from] = { contactName: contactName || from, messages: [] };
    }

    const seq     = ++msgSeq;
    const message = { type: 'incoming', text, timestamp: new Date(), seq };
    conversations[from].messages.push(message);

    // Broadcast to UI
    io.emit('new_message', {
        phone:       from,
        message,
        contactName: conversations[from].contactName
    });

    // Persist to Supabase (non-blocking)
    saveMessage(from, conversations[from].contactName, message);

    res.sendStatus(200);
});

// ── Endpoint 2: n8n sends the AI's outgoing messages here ─────────────────
app.post('/webhook/outgoing-ai', async (req, res) => {
    console.log('🤖 AI REPLY:', req.body);
    const { to, text } = req.body;

    if (!conversations[to]) {
        conversations[to] = { contactName: to, messages: [] };
    }

    const seq     = msgSeq + 1.5;       // always slots after the last incoming
    const message = { type: 'ai', text, timestamp: new Date(), seq };
    conversations[to].messages.push(message);

    io.emit('new_message', {
        phone:       to,
        message,
        contactName: conversations[to].contactName
    });

    saveMessage(to, conversations[to].contactName, message);

    res.sendStatus(200);
});

// ── Endpoint 3: UI sends a human reply → forwards to n8n ──────────────────
app.post('/api/send-reply', async (req, res) => {
    const { to, text } = req.body;

    try {
        const N8N_WEBHOOK_URL = 'https://api.thebhiveresort.in/webhook/human-reply';
        await axios.post(N8N_WEBHOOK_URL, { to, text });

        const seq     = ++msgSeq;
        const message = { type: 'human', text, timestamp: new Date(), seq };
        conversations[to].messages.push(message);

        io.emit('new_message', {
            phone:       to,
            message,
            contactName: conversations[to].contactName
        });

        saveMessage(to, conversations[to].contactName, message);

        res.json({ success: true });
    } catch (error) {
        console.error('Error sending to n8n:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Send all history to a newly connected client ───────────────────────────
io.on('connection', (socket) => {
    socket.emit('initial_data', conversations);
});

// ── Start server after loading history from DB ─────────────────────────────
const PORT = process.env.PORT || 3000;
loadConversations().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
});