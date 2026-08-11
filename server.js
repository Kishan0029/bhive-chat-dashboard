require('dotenv').config();
const fs = require('fs');
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

// ── Dashboard Authentication (Cookie Based) ───────────────────────────────
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === '6123') {
        res.cookie('bhive_auth', 'true', { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
        return res.json({ success: true });
    }
    return res.status(401).json({ success: false, message: 'Invalid password' });
});

app.post('/logout', (req, res) => {
    res.clearCookie('bhive_auth');
    res.json({ success: true });
});

app.use((req, res, next) => {
    // Skip auth for API routes, Webhooks, and login routes
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/') || req.path === '/login' || req.path === '/logout') {
        return next();
    }
    
    const cookies = req.headers.cookie || '';
    if (cookies.includes('bhive_auth=true')) {
        return next();
    }

    res.redirect('/login');
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Supabase client ────────────────────────────────────────────────────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// ── In-memory store (rebuilt from DB on startup) ───────────────────────────
const conversations = {};
const takeover = {}; // phone -> boolean
let blockedUsers = {}; // phone -> boolean
let msgSeq = 0;

// Load all past messages from Supabase into memory on startup
async function loadConversations() {
    try {
        let allMessages = [];
        let fromRow = 0;
        const limit = 1000;
        while (true) {
            const { data, error } = await supabase
                .from('messages')
                .select('*')
                .order('seq', { ascending: true })
                .range(fromRow, fromRow + limit - 1);

            if (error) throw error;
            if (!data || data.length === 0) break;
            allMessages = allMessages.concat(data);
            if (data.length < limit) break;
            fromRow += limit;
        }

        allMessages.forEach(row => {
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
            if (row.seq > msgSeq) msgSeq = Math.ceil(row.seq);
        });

        console.log(`✅ Loaded ${allMessages.length} messages from Supabase (Max seq: ${msgSeq})`);

        try {
            if (fs.existsSync('takeover.json')) {
                takeover = JSON.parse(fs.readFileSync('takeover.json', 'utf8')) || {};
            }
            if (fs.existsSync('blocked.json')) {
                blockedUsers = JSON.parse(fs.readFileSync('blocked.json', 'utf8')) || {};
            }
            const { data: tData } = await supabase.from('takeover_status').select('*');
            if (tData) {
                tData.forEach(row => {
                    if (row.active) takeover[row.phone] = true;
                });
            }
        } catch (e) {}
    } catch (err) {
        console.error('⚠️  Could not load from Supabase (continuing with empty state):', err.message);
    }
}

async function saveTakeover(phone, active) {
    try {
        if (active) {
            takeover[phone] = true;
        } else {
            delete takeover[phone];
        }
        fs.writeFileSync('takeover.json', JSON.stringify(takeover, null, 2), 'utf8');

        if (active) {
            await supabase.from('takeover_status').upsert({ phone, active: true, updated_at: new Date() });
        } else {
            await supabase.from('takeover_status').delete().eq('phone', phone);
        }
    } catch (e) {}
}

async function saveBlock(phone, active) {
    try {
        if (active) {
            blockedUsers[phone] = true;
        } else {
            delete blockedUsers[phone];
        }
        fs.writeFileSync('blocked.json', JSON.stringify(blockedUsers, null, 2), 'utf8');
    } catch (e) {}
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

// ── Endpoint: Proxy WhatsApp Messages (Intercepts n8n media) ───────────────
app.post('/api/proxy-whatsapp', async (req, res) => {
    const body = req.body;
    
    // 1. Forward to actual WhatsApp API
    try {
        // Always use the token from environment - n8n doesn't pass the Bearer header reliably
        const waToken = process.env.WHATSAPP_TOKEN || req.headers.authorization?.replace('Bearer ', '');
        const waRes = await fetch('https://graph.facebook.com/v20.0/1266911389833988/messages', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${waToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        
        const data = await waRes.json();
        if (!waRes.ok) {
            console.error('❌ Meta API Proxy Error:', waRes.status, JSON.stringify(data));
        } else {
            console.log(`✅ Proxy sent ${body.type} to ${body.to}`);
        }
        res.status(waRes.status).json(data);

        
        // 2. Sync Media to Web UI AFTER successful forward
        if (waRes.ok && (body.type === 'image' || body.type === 'document' || body.type === 'interactive')) {
            const to = body.to;
            let textStr = '';
            
            if (body.type === 'image' && body.image) {
                textStr = `[IMAGE|${body.image.link}]`;
            } else if (body.type === 'document' && body.document) {
                textStr = `[DOCUMENT|${body.document.link}|${body.document.filename || 'Document'}]`;
            } else if (body.type === 'interactive' && body.interactive) {
                const int = body.interactive;
                textStr = int.body ? int.body.text : 'Interactive Menu';
                if (int.type === 'button' && int.action && int.action.buttons) {
                    textStr += '\n\n' + int.action.buttons.map(b => `[🔘 ${b.reply.title}]`).join(' ');
                } else if (int.type === 'list' && int.action && int.action.button) {
                    textStr += '\n\n[📋 ' + int.action.button + ']';
                }
            }

            if (textStr) {
                const seq = ++msgSeq;
                const message = { type: 'ai', text: textStr, timestamp: new Date(), seq };
                
                if (!conversations[to]) {
                    conversations[to] = { contactName: to, messages: [] };
                }
                conversations[to].messages.push(message);
                
                io.emit('new_message', {
                    phone: to,
                    message,
                    contactName: conversations[to].contactName
                });
                
                saveMessage(to, conversations[to].contactName, message);
            }
        }
    } catch (e) {
        console.error('Proxy Error:', e.message);
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

// Serve index.html from root directory
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Name display rule ────────────────────────────────────────────────────────
// Contact names are ONLY set via /api/update-contact-name (called by n8n when
// the guest explicitly tells the AI their name). Until that happens, the UI
// shows the guest's phone number. All auto-guessing is intentionally removed.
// ─────────────────────────────────────────────────────────────────────────────


// ── Endpoint 1: n8n sends incoming WhatsApp messages here ──────────────────
app.post('/webhook/incoming', async (req, res) => {
    console.log('🔥 INCOMING:', req.body);
    const { from, text, contactName } = req.body;

    if (!conversations[from]) {
        conversations[from] = { contactName: contactName || from, messages: [] };
    }

    if (contactName && (!conversations[from].contactName || conversations[from].contactName === from || /^\+?\d+$/.test(String(conversations[from].contactName)))) {
        conversations[from].contactName = contactName;
        supabase.from('messages').update({ contact_name: contactName }).eq('phone', from).then();
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

    res.json(req.body);
});

// ── Endpoint 2: n8n sends the AI's outgoing messages here ─────────────────
app.post('/webhook/outgoing-ai', async (req, res) => {
    console.log('🤖 AI REPLY:', req.body);
    const { to, text } = req.body;

    if (!conversations[to]) {
        conversations[to] = { contactName: to, messages: [] };
    }

    const seq     = ++msgSeq;
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

// ── Endpoint: Internal webhook sends media messages here ──────────────────
app.post('/api/sync-media', async (req, res) => {
    console.log('🖼️ AI MEDIA:', req.body);
    const { to, mediaUrl, mediaType, filename } = req.body;

    if (!to || !mediaUrl || !mediaType) return res.sendStatus(400);

    if (!conversations[to]) {
        conversations[to] = { contactName: to, messages: [] };
    }

    const seq = ++msgSeq; // Tool runs first, so this gets a lower seq than the final text
    
    // Use special formatting so we don't need to change DB schema
    let textStr = '';
    if (mediaType === 'image') {
        textStr = `[IMAGE|${mediaUrl}]`;
    } else if (mediaType === 'document') {
        textStr = `[DOCUMENT|${mediaUrl}|${filename || 'Document'}]`;
    }

    const message = { type: 'ai', text: textStr, timestamp: new Date(), seq };
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

        // Automatically activate Human Takeover when staff replies manually
        const digits = String(to).replace(/\D/g, '');
        if (!takeover[to] && !takeover[digits]) {
            takeover[to] = true;
            takeover[digits] = true;
            saveTakeover(digits, true);
            io.emit('takeover_updated', { phone: to, active: true });
        }

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

// ── Endpoint 4: Check if Human Takeover is active (for n8n IF node) ────────
app.get('/api/check-takeover', (req, res) => {
    const phone = String(req.query.phone || '').trim();
    const digits = phone.replace(/\D/g, '');
    const isTakenOver = !!takeover[phone] || !!takeover[digits];
    const isBlocked = !!blockedUsers[phone] || !!blockedUsers[digits];
    const blockAI = isTakenOver || isBlocked;
    console.log(`🔍 Check Takeover/Block for ${phone} (${digits}): Takeover=${isTakenOver}, Blocked=${isBlocked}`);
    res.json({ takeover: blockAI, blocked: isBlocked, from: phone });
});

// ── Endpoint 5: Dashboard UI toggles Human Takeover ────────────────────────
app.post('/api/toggle-takeover', (req, res) => {
    const { phone, active } = req.body;
    if (!phone) return res.status(400).json({ success: false });
    const cleanPhone = String(phone).trim();
    const digits = cleanPhone.replace(/\D/g, '');
    takeover[cleanPhone] = !!active;
    takeover[digits] = !!active;
    saveTakeover(digits, !!active);
    io.emit('takeover_updated', { phone: cleanPhone, active: !!active });
    res.json({ success: true, active: !!active });
});

// ── Endpoint 5.5: Dashboard UI toggles Block User ──────────────────────────
app.post('/api/toggle-block', (req, res) => {
    const { phone, active } = req.body;
    if (!phone) return res.status(400).json({ success: false });
    const cleanPhone = String(phone).trim();
    const digits = cleanPhone.replace(/\D/g, '');
    blockedUsers[cleanPhone] = !!active;
    blockedUsers[digits] = !!active;
    saveBlock(digits, !!active);
    io.emit('blocked_updated', { phone: cleanPhone, active: !!active });
    res.json({ success: true, active: !!active });
});

// ── Endpoint 6: Update Guest Contact Name (called by n8n AI tool) ──────────
app.post('/api/update-contact-name', async (req, res) => {
    const { phone, name } = req.body;
    if (!phone || !name) return res.status(400).json({ success: false });

    if (conversations[phone]) {
        conversations[phone].contactName = name;
    } else {
        conversations[phone] = { contactName: name, messages: [] };
    }

    try {
        await supabase.from('messages').update({ contact_name: name }).eq('phone', phone);
    } catch (e) {
        console.error('⚠️  Supabase contact name update failed:', e.message);
    }

    io.emit('contact_name_updated', { phone, name });
    res.json({ success: true, phone, name });
});

// ── Meta Flows Endpoint (Encrypted) ────────────────────────────────────────
const crypto = require('crypto');

// The Private Key to decrypt incoming Flow requests
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCfVTI/xSPShbpe
dovc4OlWPZIV/OEDGr+7W8P2/dteN1z+55edVVRf6/No9C8SPhngEobBdnuC/bbS
0RsXjfkMtTDXxyoNSSMvC4CI7tIN2WjswpxyDt60FehiyusTEFc0N+OuGFkAkrs8
bOLve3PNhkMYKumlsNOd9l42OvvfEPQOjeruwXxkxhaGUit7iYXab1YLiMoHyApL
Qhh1CDsVscfnNdaC3Z1PbgpvUKav775wkM3o48hod/xlXYHqD+4ZADgUZJEFvxzF
RGmoSURPaccywrvT2a05tvov4rMVvH98tF3hGCF6sNgBpU3Q9twEwhHYDjBeHYQI
EMIuKKAFAgMBAAECggEALBw6gpQR1EUIcQFxvA8aGjGGgYbWRnU/0l9X08e41Q8P
tFQqUbjfWITqiMpdQ7gkkreeTe3+yKdz105jqTQ5WC7LXFl7h10RnAMbrQ0s4v+n
ADDqfdsnBYUxJjSWOtthwQeeBUMhVLrKkjJ06ybqyuHaLlUnBSN8mnUr5OiUdU78
5NkAwRAR1wBMLj94zFMhbTtI+YVIM5VxCAUFFEvQuLtxTljkIKMvb+A7DOHYgAVF
+qhmrHlGqMKsKYKSzpV25d2RtnYEZUBisZ9VKBmc/FWVCEorFDdiSPxJ2tcsQruN
D0nXvP4RmPoe6/6zJULqFzfDqq5xjZ+cIB9VLgonGwKBgQDMLUgBMopTLdKAGFTe
47KQU4eRBihxNws0yTbO6bngfq3i+6nWyBbxrTXxxYC2YA7+8UJka9/ZnDLDB1X9
bSpxajRxPGeILh6X9GcrMxSVSnWmAal8QEUG8poF/CMITaNGA7juj+qKAAyI3B+L
LjT7J2pFycVZcYL8ztzuZMGwbwKBgQDHxhllNzSZ+LuRxAdJycSbF7JMQF9iZAbz
agO1fkjF8XMCAqJ54l0Sdu2XRoQ2owegnn2Rtby55JkUUAPbz5GQBchyG3U6+GvQ
CrTr5Uor7TEe8W7DIyXTF5cpHKEnRCAymKq9qeq9D0jqLsbahF027NLJRuX2Vq90
3Qf77HXIywKBgHtCatGuPStx4j5KchIMy+OtSY4XdZrDbBR11IydNQV99GOvIhzz
tkY4FvTaEpYG74ahBz+wj/bDATIT36mamaDWSMqDeM0Rao65kP7XW3m09ck9/59u
/TzwgGNUj6GXnRXLcX0zjJe659ZHbROM1Zc5eEKhSG5yxGzyRRX15agpAoGBAKe8
kogksTry2PMMSB5Rlo2ueNuDVVN0r01kX1bdgNcK40j101xJj2I4j0dsQwjpHDdl
vANDOAJRiaK/iG3gu9TUtjfxDB6GhWe6Bazn6b42Ov9DMoAQG+tBLH+tdTZWAj7Z
Zss3R0yU7+EJg5foeafrcxTjPaT3pfyWteR153O/AoGALOhDVude+z3080nNdJLV
Yo4uQhZugOegylcJqQ8guJoyAewFAzPYeV81Og+tfyCc7Jrnb9gl0esywFm03iuA
uB8kcWQhBA4VaKjAjPkfgELAK25L/t/jpgr1nT4fIp39bdAOk6Tg20K+Oppw8wuC
z2Y/OGYVLLyOiWAGzrccPB0=
-----END PRIVATE KEY-----`;

app.post('/api/meta-flow', async (req, res) => {
    try {
        const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;
        
        if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector) {
            return res.status(400).send("Missing encryption parameters");
        }

        // 1. Decrypt the AES key using our RSA Private Key
        const decryptedAesKey = crypto.privateDecrypt(
            {
                key: PRIVATE_KEY,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            Buffer.from(encrypted_aes_key, 'base64')
        );

        // 2. Decrypt the flow data payload
        const iv = Buffer.from(initial_vector, 'base64');
        const ciphertextBuffer = Buffer.from(encrypted_flow_data, 'base64');
        // Meta splits auth tag from end of ciphertext (last 16 bytes)
        const authTag = ciphertextBuffer.slice(ciphertextBuffer.length - 16);
        const encryptedData = ciphertextBuffer.slice(0, ciphertextBuffer.length - 16);

        const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, iv);
        decipher.setAuthTag(authTag);
        let decryptedDataStr = decipher.update(encryptedData, undefined, 'utf8');
        decryptedDataStr += decipher.final('utf8');
        
        const body = JSON.parse(decryptedDataStr);
        console.log(`[META FLOW] Decrypted request:`, body);

        let responseData = {};

        // 3. Handle the Flow logic
        if (body.action === 'ping') {
            responseData = { data: { status: 'active' } };
        } else if (body.action === 'data_exchange') {
            const data = body.data || {};
            const leadPayload = {
                name:             data.name             || 'N/A',
                phone:            data.phone            || 'N/A',
                package:          data.package          || data.stay_type || 'N/A',
                room_type:        data.room_type        || 'N/A',
                check_in:         data.check_in         || 'N/A',
                check_out:        data.check_out        || 'N/A',
                adults:           data.adults           || 'N/A',
                children:         data.children         || 'None',
                special_requests: data.special_requests || 'None'
            };

            // Forward to n8n webhook
            try {
                await axios.post('http://127.0.0.1:5678/webhook/bhive-send-lead-meta', leadPayload);
                console.log('[META FLOW] Lead forwarded to n8n successfully.');
            } catch (err) {
                console.error('[META FLOW] Failed to forward to n8n:', err.message);
            }

            responseData = { screen: 'SUCCESS', data: {} };
        } else {
            responseData = { screen: body.screen, data: {} };
        }

        // 4. Encrypt the response using AES-GCM
        const responseDataStr = JSON.stringify(responseData);
        
        // Flip all bits in the IV for the response IV
        const responseIv = Buffer.alloc(iv.length);
        for (let i = 0; i < iv.length; i++) {
            responseIv[i] = ~iv[i];
        }

        const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, responseIv);
        const encryptedResponse = Buffer.concat([
            cipher.update(responseDataStr, 'utf8'),
            cipher.final(),
            cipher.getAuthTag()
        ]);

        // Meta requires the response to be a plain base64 string
        res.send(encryptedResponse.toString('base64'));

    } catch (err) {
        console.error('[META FLOW] Encryption/Decryption error:', err.message);
        res.status(500).send('Encryption error');
    }
});

// ── Endpoint: Send Meta Flow Interactive Message ──────────────────────────
// Called by the n8n AI agent via the send-booking-form tool.
app.post('/api/send-booking-flow', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    // The Meta Flow ID provided by the user
    const FLOW_ID = process.env.META_FLOW_ID || '1750979676250518';

    const payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
            type: 'flow',
            header: {
                type: 'text',
                text: 'The B Hive Resort'
            },
            body: {
                text: 'Tap the button below to quickly fill out your booking details and check availability.'
            },
            footer: {
                text: 'Booking Enquiry'
            },
            action: {
                name: 'flow',
                parameters: {
                    flow_message_version: '3',
                    flow_token: `booking_${Date.now()}`,
                    flow_id: FLOW_ID,
                    flow_cta: '📝 Open Booking Form',
                    flow_action: 'navigate',
                    flow_action_payload: {
                        screen: 'WELCOME',
                        data: {
                            // Extract known data from conversations memory if available
                            name: conversations[phone]?.contactName || ''
                        }
                    }
                }
            }
        }
    };

    try {
        const waToken = process.env.WHATSAPP_TOKEN;
        const waRes = await fetch('https://graph.facebook.com/v20.0/1266911389833988/messages', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${waToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await waRes.json();
        
        if (!waRes.ok) {
            console.error('❌ Failed to send Flow:', data);
            return res.status(waRes.status).json({ success: false, error: data });
        }

        // Add to chat history
        const message = { type: 'ai', text: '[Interactive Booking Form Sent]', timestamp: new Date(), seq: ++msgSeq };
        if (conversations[phone]) conversations[phone].messages.push(message);
        saveMessage(phone, conversations[phone]?.contactName || phone, message);

        res.json({ success: true, message: 'Flow sent successfully', data });
    } catch (err) {
        console.error('❌ Error sending Flow:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Deduplication State Store for Send Lead To Owner ──────────
const sentLeads = {}; // phone -> timestamp in ms

// Endpoint: POST /api/send-lead-to-owner
// Checks if lead was already sent for this guest within the last 24 hours.
app.post('/api/send-lead-to-owner', async (req, res) => {
    console.log('--- SEND LEAD REQUEST BODY ---');
    console.log(JSON.stringify(req.body, null, 2));
    const { phone } = req.body;
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    const digits = phone ? String(phone).replace(/\D/g, '').slice(-10) : null;

    if (digits && sentLeads[digits] && (now - sentLeads[digits]) < ONE_HOUR) {
        console.log(`[DEDUP] Blocking duplicate send_lead_to_owner for ${digits} (sent ${(now - sentLeads[digits])/1000}s ago)`);
        return res.json({
            success: true, // MUST BE TRUE SO AI DOES NOT TRIGGER FIX 4 APOLOGY
            status: "already_submitted",
            message: "This booking has ALREADY been sent to our team for this guest earlier today. Do NOT resend or claim to send again. Reply to the guest: 'This booking has already been sent to our team — no need to resend!' and ask if they need anything else."
        });
    }

    if (digits) {
        sentLeads[digits] = now;
    }

    try {
        const resp = await axios.post('http://127.0.0.1:5678/webhook/bhive-send-lead-meta', req.body);
        return res.json({
            success: true,
            status: "sent",
            message: "Lead successfully sent to reservations team."
        });
    } catch (err) {
        console.error('⚠️  Failed to send lead to webhook/bhive-send-lead-meta:', err.message);
        if (digits) delete sentLeads[digits];
        return res.status(500).json({
            success: false,
            status: "error",
            message: "Failed to send lead to reservations team: " + err.message
        });
    }
});

// Helper for testing: simulate 1-hour expiration by setting timestamp to 2 hours ago
app.post('/api/test-expire-lead', (req, res) => {
    const { phone } = req.body || req.query;
    const digits = phone ? String(phone).replace(/\D/g, '').slice(-10) : null;
    if (digits && sentLeads[digits]) {
        sentLeads[digits] = Date.now() - (2 * 60 * 60 * 1000);
        return res.json({ success: true, phone, digits, status: "expired_2_hours_ago" });
    }
    return res.json({ success: false, message: "No lead found for phone" });
});

// Helper for testing: clear deduplication flag for phone
app.post('/api/test-clear-lead', (req, res) => {
    const { phone } = req.body || req.query;
    const digits = phone ? String(phone).replace(/\D/g, '').slice(-10) : null;
    if (digits) {
        delete sentLeads[digits];
    }
    return res.json({ success: true, phone, digits, status: "cleared" });
});

// ── Send all history and takeover state to a newly connected client ────────
io.on('connection', (socket) => {
    socket.emit('initial_data', { conversations, takeover, blockedUsers });
});

// ── Start server after loading history from DB ─────────────────────────────
const PORT = process.env.PORT || 3000;
loadConversations().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
});