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
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
// Запасні моделі: якщо основна перевантажена (503 / "high demand") або недоступна (404),
// пробуємо наступну. Можна змінити змінною середовища GEMINI_FALLBACK_MODELS (через кому).
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash-lite,gemini-2.5-flash")
    .split(',').map(m => m.trim()).filter(Boolean);
const MODELS = [MODEL, ...FALLBACK_MODELS.filter(m => m !== MODEL)];
const REQUEST_TIMEOUT_MS = 120000;
const TTS_MODEL = "gemini-3.1-flash-tts-preview";
const TTS_VOICE = "Kore"; // тепла жіноча інтонація; інші варіанти: Leda, Aoede, Callirrhoe...

// Gemini TTS повертає сирий PCM (16-біт, моно) — загортаємо його у WAV,
// щоб браузер міг програти файл напряму через <audio>/data URI без декодування PCM.
function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;
    const dataSize = pcmBuffer.length;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    pcmBuffer.copy(buffer, 44);

    return buffer;
}

function parseSampleRate(mimeType) {
    const match = /rate=(\d+)/.exec(mimeType || '');
    return match ? parseInt(match[1], 10) : 24000;
}

// Класифікація помилки Gemini
function classifyError(err) {
    const code = err?.code, status = err?.status, msg = (err?.message || '').toLowerCase();
    if (code === 429 || status === 'RESOURCE_EXHAUSTED') return 'quota';        // ліміт ключа/проєкту → інший ключ
    if (code === 503 || status === 'UNAVAILABLE' || msg.includes('high demand') || msg.includes('overloaded'))
        return 'overloaded';                                                      // модель перевантажена → інша модель
    if (code === 404 || status === 'NOT_FOUND') return 'model_missing';          // моделі немає → інша модель
    return 'other';                                                               // невірний ключ тощо → інший ключ
}

app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;

    if (!apiKeys.length) {
        return res.status(500).json({ ok: false, error: 'Секретные ключи не настроены' });
    }

    let overloadedSeen = false;
    let lastError = '';

    for (const model of MODELS) {
        let attempts = 0;

        while (attempts < apiKeys.length) {
            const currentKey = apiKeys[currentKeyIndex];

            try {
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: { temperature: 0.35 }
                        }),
                        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                    }
                );

                const data = await response.json();

                if (data.error) {
                    lastError = data.error.message || String(data.error.code);
                    const kind = classifyError(data.error);

                    if (kind === 'overloaded') {
                        // Перевантажена модель — для всіх ключів однаково, ключі НЕ перебираємо
                        console.log(`[${model}] перевантажена: ${lastError} → наступна модель`);
                        overloadedSeen = true;
                        break;
                    }
                    if (kind === 'model_missing') {
                        console.log(`[${model}] недоступна: ${lastError} → наступна модель`);
                        break;
                    }
                    console.log(`[${model}] ключ #${currentKeyIndex} ${kind === 'quota' ? 'залімічений' : 'помилка: ' + lastError}, наступний ключ...`);
                    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                    attempts++;
                    continue;
                }

                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text) {
                    // порожня відповідь (наприклад, блокування) — пробуємо іншу модель
                    lastError = 'порожня відповідь: ' + (data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown');
                    console.log(`[${model}] ${lastError} → наступна модель`);
                    break;
                }

                // Успіх — залишаємось на цьому ключі для наступного запиту
                if (model !== MODEL) console.log(`Відповідь отримано від запасної моделі ${model}`);
                return res.json({ ok: true, text, model });

            } catch (error) {
                lastError = error.message;
                console.log(`[${model}] ключ #${currentKeyIndex} виняток: ${error.message}`);
                currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                attempts++;
            }
        }
    }

    const status = overloadedSeen ? 503 : 500;
    res.status(status).json({
        ok: false,
        error: overloadedSeen ? 'Моделі Gemini перевантажені (high demand), спробуйте ще раз за хвилину' : 'Все ключи недоступны: ' + lastError
    });
});

app.post('/api/tts', async (req, res) => {
    const { text, voice } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ ok: false, error: 'Текст для озвучки відсутній' });
    }
    if (!apiKeys.length) {
        return res.status(500).json({ ok: false, error: 'Секретные ключи не настроены' });
    }

    const voiceName = voice || TTS_VOICE;
    let attempts = 0;

    while (attempts < apiKeys.length) {
        const currentKey = apiKeys[currentKeyIndex];

        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${currentKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text }] }],
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: {
                                voiceConfig: { prebuiltVoiceConfig: { voiceName } }
                            }
                        }
                    })
                }
            );

            const data = await response.json();

            if (data.error?.code === 429 || data.error?.status === 'RESOURCE_EXHAUSTED') {
                console.log(`TTS: ключ #${currentKeyIndex} залімічений, переходжу до наступного...`);
                currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                attempts++;
                continue;
            }

            if (data.error) {
                console.log(`TTS: ключ #${currentKeyIndex} помилка: ${data.error.message}`);
                currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                attempts++;
                continue;
            }

            const part = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
            if (!part?.data) {
                return res.status(500).json({ ok: false, error: 'Модель не повернула аудіо' });
            }

            const pcmBuffer = Buffer.from(part.data, 'base64');
            const sampleRate = parseSampleRate(part.mimeType);
            const wavBuffer = pcmToWav(pcmBuffer, sampleRate, 1, 16);

            return res.json({ ok: true, audio: wavBuffer.toString('base64'), mimeType: 'audio/wav' });

        } catch (error) {
            console.log(`TTS: ключ #${currentKeyIndex} виняток: ${error.message}`);
            currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            attempts++;
        }
    }

    res.status(500).json({ ok: false, error: 'Все ключи недоступны' });
});

// Перевірка що сервер живий
app.get('/health', (req, res) => {
    res.json({ ok: true, keys: apiKeys.length, currentKey: currentKeyIndex, models: MODELS });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Завантажено ключів: ${apiKeys.length}`);
});
