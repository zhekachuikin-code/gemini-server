require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const apiKeys = process.env.GEMINI_KEYS ? process.env.GEMINI_KEYS.split(',') : [];
let currentKeyIndex = 0;
const MODEL = "gemini-3.1-flash-lite";

app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;

    if (!apiKeys.length) {
        return res.status(500).json({ error: 'Секретные ключи не найдены' });
    }

    let attempts = 0;
    
    while (attempts < apiKeys.length) {
        const currentKey = apiKeys[currentKeyIndex];
        
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${currentKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    contents: [{ parts: [{ text: prompt }] }], 
                    generationConfig: { temperature: 0.35 } 
                })
            });

            const data = await response.json();

            if (data.error) {
                currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                attempts++;
                continue;
            }

            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            return res.json({ ok: true, text });

        } catch (error) {
            currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            attempts++;
        }
    }

    res.status(500).json({ ok: false, error: 'Все ключи недоступны' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});