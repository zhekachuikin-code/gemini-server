require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const apiKeys = process.env.GEMINI_KEYS ? process.env.GEMINI_KEYS.split(',').map(k => k.trim()) : [];
let currentKeyIndex = 0;
const MODEL = "gemini-3.1-flash-lite";

app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;

    if (!apiKeys.length) {
        return res.status(500).json({ error: 'Секретные ключи не настроены' });
    }

    let attempts = 0;

    while (attempts < apiKeys.length) {
        const currentKey = apiKeys[currentKeyIndex];

        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${currentKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.35 }
                    })
                }
            );

            const data = await response.json();

            // 429 — ліміт вичерпано, переходимо до наступного ключа
            if (data.error?.code === 429 || data.error?.status === 'RESOURCE_EXHAUSTED') {
                console.log(`Ключ #${currentKeyIndex} залімічений, переходжу до наступного...`);
                currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                attempts++;
                continue;
            }

            // Інша помилка API
            if (data.error) {
                console.log(`Ключ #${currentKeyIndex} помилка: ${data.error.message}`);
                currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                attempts++;
                continue;
            }

            // Успіх — залишаємось на цьому ключі для наступного запиту
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            return res.json({ ok: true, text });

        } catch (error) {
            console.log(`Ключ #${currentKeyIndex} виняток: ${error.message}`);
            currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            attempts++;
        }
    }

    res.status(500).json({ ok: false, error: 'Все ключи недоступны' });
});

// Перевірка що сервер живий
app.get('/health', (req, res) => {
    res.json({ ok: true, keys: apiKeys.length, currentKey: currentKeyIndex });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Завантажено ключів: ${apiKeys.length}`);
});
