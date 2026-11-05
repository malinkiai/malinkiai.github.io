export const config = {
    api: {
        bodyParser: {
            sizeLimit: '25mb', // Увеличили лимит, так как теперь передаем пачку картинок
        },
    },
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Только POST запросы' });

    try {
        const { audioBase64, subject, slides } = req.body;
        const geminiKey = process.env.GEMINI_API_KEY;

        if (!geminiKey) return res.status(500).json({ error: 'Нет ключа GEMINI_API_KEY!' });

        // 1. Формируем массив данных для нейросети (Текст + Аудио)
        const parts = [
            {
                text: `Ты школьный ИИ-помощник. Проанализируй урок (${subject}). Твоя главная задача — извлечь максимум информации из приложенных скриншотов презентации/доски, так как на аудиозаписи микрофон может работать с сильными помехами. Опирайся на текст, схемы и формулы со слайдов как на железную основу конспекта!
Правила:
1. Первая строка — краткая тема (без #).
2. Со второй строки — подробный конспект по слайдам и голосу (определения, формулы, списки).
3. Если на аудио полная тишина, составь конспект ИСКЛЮЧИТЕЛЬНО по приложенным слайдам.`
            },
            {
                inlineData: { mimeType: 'audio/webm', data: audioBase64 }
            }
        ];

        // 2. Добавляем все скриншоты в мозг нейросети
        if (slides && slides.length > 0) {
            for (const slideDataUrl of slides) {
                // Отрезаем приставку "data:image/jpeg;base64," чтобы получить чистый код картинки
                const base64Img = slideDataUrl.split(',')[1];
                if (base64Img) {
                    parts.push({
                        inlineData: { mimeType: 'image/jpeg', data: base64Img }
                    });
                }
            }
        }

        const payload = { contents: [{ parts }] };
        const modelsToTry = ['gemini-3.0-flash', 'gemini-flash-latest', 'gemini-3.0-pro-preview'];
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
                if (response.status === 404 || response.status === 400) break; // Сразу меняем модель
                await new Promise(r => setTimeout(r, 1500)); // Ждем при перегрузке (503)
            }
            if (successData) break;
        }

        if (!successData) throw new Error(lastErrorMsg);

        const fullText = successData.candidates?.[0]?.content?.parts?.[0]?.text || 'Конспект готов.';
        const lines = fullText.split('\n').filter(l => l.trim() !== '');
        const title = lines[0]?.replace(/^[#*-\s]+/, '') || `Урок (${subject})`;
        const summary = lines.slice(1).join('\n') || fullText;

        return res.status(200).json({ title, summary });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
