export const config = {
    api: {
        bodyParser: {
            sizeLimit: '15mb',
        },
    },
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Разрешены только POST запросы' });
    }

    try {
        const { audioBase64, subject } = req.body;
        const geminiKey = process.env.GEMINI_API_KEY;

        if (!geminiKey) {
            return res.status(500).json({
                error: 'Ключ GEMINI_API_KEY не найден в настройках Vercel!'
            });
        }

        const payload = {
            contents: [{
                parts: [
                    {
                        text: `Ты школьный ИИ-помощник проекта "Малинки AI". Прослушай аудиозапись школьного урока (${subject}) и составь структурированный, подробный и понятный конспект для учеников.
Правила оформления:
1. Первой строкой напиши ТОЛЬКО краткую тему урока (без слов "Тема:", без решеток # и звездочек *).
2. Со второй строки напиши сам конспект: выдели главные определения, формулы, даты, правила и ключевые мысли учителя удобным списком.
3. Если на записи тишина или короткая проверка связи, укажи это кратко.`
                    },
                    {
                        inlineData: {
                            mimeType: 'audio/webm',
                            data: audioBase64
                        }
                    }
                ]
            }]
        };

        // Функция запроса к актуальной модели gemini-3.0-flash с автоповтором при частых запросах
        async function callGemini(modelName, attempt = 1) {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }
            );

            const data = await response.json();

            // Если бесплатный тариф просит подождать пару секунд (код 429 или 503) — ждем 3 секунды и повторяем
            if ((response.status === 429 || response.status === 503) && attempt < 3) {
                await new Promise(r => setTimeout(r, 3000));
                return callGemini(modelName, attempt + 1);
            }

            return { ok: response.ok, status: response.status, data };
        }

        // Сначала вызываем gemini-3.0-flash, при 404 — резервный алиас gemini-flash-latest
        let result = await callGemini('gemini-3.0-flash');
        if (result.status === 404) {
            result = await callGemini('gemini-flash-latest');
        }

        if (!result.ok || !result.data.candidates) {
            const errMsg = result.data?.error?.message || 'Нейросеть не смогла обработать запись. Подождите 15 секунд и попробуйте снова.';
            throw new Error(errMsg);
        }

        const fullText = result.data.candidates?.[0]?.content?.parts?.[0]?.text || 'Конспект успешно сформирован.';
        const lines = fullText.split('\n').filter(l => l.trim() !== '');
        const title = lines[0]?.replace(/^[#*-\s]+/, '') || `Урок (${subject})`;
        const summary = lines.slice(1).join('\n') || fullText;

        return res.status(200).json({ title, summary });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
