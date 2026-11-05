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

        // Каскад из разных моделей: если основная перегружена (High demand), мгновенно берется следующая свободная
        const modelsToTry = [
            'gemini-3.0-flash',
            'gemini-3.0-flash-lite-preview',
            'gemini-flash-lite-latest',
            'gemini-flash-latest',
            'gemini-3.0-pro-preview'
        ];

        let successData = null;
        let lastErrorMsg = '';

        for (const modelName of modelsToTry) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    }
                );

                const data = await response.json();

                if (response.ok && data.candidates) {
                    successData = data;
                    break;
                }

                lastErrorMsg = data.error?.message || `Ошибка ${response.status}`;

                // Если модель не существует для этого ключа (404), сразу переходим к следующей модели в списке
                if (response.status === 404 || response.status === 400) {
                    break;
                }

                // Если сервер перегружен (503 High demand или 429), ждем 1.5 сек и пробуем еще раз или идем на следующую модель
                await new Promise(r => setTimeout(r, 1500));
            }
            if (successData) break;
        }

        if (!successData) {
            throw new Error(lastErrorMsg);
        }

        const fullText = successData.candidates?.[0]?.content?.parts?.[0]?.text || 'Конспект успешно сформирован.';
        const lines = fullText.split('\n').filter(l => l.trim() !== '');
        const title = lines[0]?.replace(/^[#*-\s]+/, '') || `Урок (${subject})`;
        const summary = lines.slice(1).join('\n') || fullText;

        return res.status(200).json({ title, summary });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
