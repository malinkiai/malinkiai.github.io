export const config = {
    api: {
        bodyParser: {
            sizeLimit: '20mb',
        },
    },
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Разрешены только POST запросы' });

    try {
        const { audioBase64, subject, slides } = req.body;
        const geminiKey = process.env.GEMINI_API_KEY;

        if (!geminiKey) {
            return res.status(500).json({ error: 'Ключ GEMINI_API_KEY не найден в настройках Vercel!' });
        }

        const parts = [
            {
                text: `Ты школьный ИИ-помощник проекта "Малинки AI". Проанализируй школьный урок (${subject}).
Мы передаем тебе аудиозапись с микрофона и скриншоты экрана/презентации учителя.
Так как микрофон может записывать тихо, ОБЯЗАТЕЛЬНО прочитай весь текст, заголовки, определения и формулы со скриншотов слайдов и объедини их с тем, что слышно на аудио!
Правила оформления:
1. Первой строкой напиши ТОЛЬКО краткую тему урока (без слов "Тема:", без символов # и *).
2. Со второй строки напиши подробный, структурированный конспект для учеников (основные понятия, формулы, тезисы со слайдов и объяснения учителя).`
            },
            {
                inlineData: {
                    mimeType: 'audio/webm',
                    data: audioBase64
                }
            }
        ];

        // Прикрепляем до 4 ключевых слайдов, чтобы не перегружать лимит бесплатного тарифа
        if (slides && Array.isArray(slides) && slides.length > 0) {
            const selectedSlides = slides.slice(0, 4);
            for (const slideDataUrl of selectedSlides) {
                const base64Img = slideDataUrl.split(',')[1];
                if (base64Img) {
                    parts.push({
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: base64Img
                        }
                    });
                }
            }
        }

        const payload = { contents: [{ parts }] };

        // Вызываем ТОЛЬКО рабочую модель gemini-3.0-flash с автоповтором при вечерней нагрузке (503/429)
        async function callGeminiWithRetry(modelName, maxAttempts = 3) {
            let lastErr = '';
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
                    return { ok: true, data };
                }

                lastErr = data.error?.message || `Ошибка сервера (${response.status})`;

                if (response.status === 503 || response.status === 429) {
                    await new Promise(r => setTimeout(r, 2500 * attempt));
                    continue;
                }
                break;
            }
            return { ok: false, error: lastErr };
        }

        let result = await callGeminiWithRetry('gemini-3.0-flash', 3);

        if (!result.ok) {
            throw new Error(result.error);
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
