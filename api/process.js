export const config = {
    api: {
        bodyParser: {
            sizeLimit: '15mb',
        },
    },
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Разрешены только POST запросы' });
    }

    try {
        const { audioBase64, subject, slides } = req.body;
        const geminiKey = process.env.GEMINI_API_KEY;
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_KEY;

        if (!geminiKey) {
            return res.status(500).json({
                error: 'Ключ GEMINI_API_KEY не найден в настройках Vercel (Environment Variables)!'
            });
        }

        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            {
                                text: `Ты школьный ИИ-помощник проекта "Малинки AI". Прослушай аудиозапись школьного урока по предмету "${subject}" и составь структурированный, понятный конспект для учеников.
Правила оформления:
1. Первой строкой напиши ТОЛЬКО краткую тему урока (без слов "Тема:", без решеток # и звездочек *).
2. Со второй строки напиши сам конспект: выдели главные определения, формулы, правила и ключевые мысли учителя удобным списком.
3. Если на записи плохо слышно речь или тишина, напиши: "Тестовая запись микрофона" первой строкой, а ниже — что звук успешно дошел до сервера, но речь была слишком тихой.`
                            },
                            {
                                inlineData: {
                                    mimeType: 'audio/webm',
                                    data: audioBase64
                                }
                            }
                        ]
                    }]
                })
            }
        );

        const geminiData = await geminiRes.json();
        if (!geminiRes.ok) {
            throw new Error(geminiData.error?.message || 'Ошибка при обращении к Gemini API');
        }

        const fullText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'Конспект успешно сформирован.';
        const lines = fullText.split('\n').filter(l => l.trim() !== '');
        const title = lines[0]?.replace(/^[#*-\s]+/, '') || `Урок (${subject})`;
        const summary = lines.slice(1).join('\n') || fullText;

        // Автоматическое сохранение в Supabase (если добавите базу позже)
        if (supabaseUrl && supabaseKey) {
            await fetch(`${supabaseUrl}/rest/v1/lessons`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({ subject, title, summary, slides: slides || [] })
            });
        }

        return res.status(200).json({ title, summary });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
