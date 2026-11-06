import fs from 'fs';
import path from 'path';

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '20mb',
        },
    },
};

const TMP_FILE = path.join('/tmp', 'malinki_shared_lessons.json');

// Чтение общих конспектов с сервера Vercel
function getSharedLessons() {
    try {
        if (fs.existsSync(TMP_FILE)) {
            const raw = fs.readFileSync(TMP_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {}
    return globalThis.malinkiLessons || [];
}

// Сохранение нового конспекта на сервере для всех учеников
function saveSharedLesson(newLesson) {
    const lessons = getSharedLessons();
    lessons.unshift(newLesson);
    const trimmed = lessons.slice(0, 25); // Храним последние 25 уроков
    globalThis.malinkiLessons = trimmed;
    try {
        fs.writeFileSync(TMP_FILE, JSON.stringify(trimmed), 'utf8');
    } catch (e) {}
    return trimmed;
}

function clearSharedLessons() {
    globalThis.malinkiLessons = [];
    try {
        if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    } catch (e) {}
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    // 1. GET-запрос: отдаем список конспектов всем ученикам на любые устройства
    if (req.method === 'GET') {
        try {
            if (supabaseUrl && supabaseKey) {
                const sbRes = await fetch(`${supabaseUrl}/rest/v1/lessons?select=*&order=id.desc&limit=25`, {
                    headers: {
                        'apikey': supabaseKey,
                        'Authorization': `Bearer ${supabaseKey}`
                    }
                });
                if (sbRes.ok) {
                    const sbLessons = await sbRes.json();
                    return res.status(200).json({ lessons: sbLessons });
                }
            }
            return res.status(200).json({ lessons: getSharedLessons() });
        } catch (err) {
            return res.status(200).json({ lessons: getSharedLessons() });
        }
    }

    // 2. DELETE-запрос: очистка тестовых записей
    if (req.method === 'DELETE') {
        clearSharedLessons();
        return res.status(200).json({ ok: true, lessons: [] });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Метод не поддерживается' });
    }

    // 3. POST-запрос: генерация конспекта через ИИ и публикация для всех
    try {
        const { audioBase64, subject, slides, time } = req.body;
        const geminiKey = process.env.GEMINI_API_KEY;

        if (!geminiKey) {
            return res.status(500).json({ error: 'Ключ GEMINI_API_KEY не найден в настройках Vercel!' });
        }

        const parts = [
            {
                text: `Ты школьный ИИ-помощник проекта "Малинки AI". Составь подробный и понятный учебный конспект урока (${subject}) для школьников.
Обязательно используй информацию, текст, формулы и схемы со скриншотов экрана/презентации, а также голос учителя с аудиозаписи (если речь тихая или с помехами — опирайся на слайды!).
Правила ответа:
1. Первой строкой напиши ТОЛЬКО краткую тему урока (без слов "Тема:", без символов # и *).
2. Со второй строки напиши структурированный конспект: основные определения, формулы, правила и тезисы списком.`
            }
        ];

        if (audioBase64 && audioBase64.length > 100) {
            parts.push({
                inlineData: { mimeType: 'audio/webm', data: audioBase64 }
            });
        }

        if (Array.isArray(slides) && slides.length > 0) {
            for (const slideDataUrl of slides.slice(0, 4)) {
                const base64Img = slideDataUrl.split(',')[1];
                if (base64Img) {
                    parts.push({
                        inlineData: { mimeType: 'image/jpeg', data: base64Img }
                    });
                }
            }
        }

        // Автоматически запрашиваем у Google список доступных моделей (ListModels), чтобы никогда не было ошибки 404
        let candidateModels = ['gemini-3.0-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
        try {
            const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
            if (listRes.ok) {
                const listData = await listRes.json();
                const available = (listData.models || [])
                    .filter(m =>
                        m.supportedGenerationMethods?.includes('generateContent') &&
                        m.name.includes('gemini') &&
                        !m.name.includes('1.5') &&
                        !m.name.includes('2.0') &&
                        !m.name.includes('2.5-flash') &&
                        !m.name.includes('tts') &&
                        !m.name.includes('image') &&
                        !m.name.includes('embedding') &&
                        !m.name.includes('robotics')
                    )
                    .map(m => m.name.replace('models/', ''));

                if (available.length > 0) {
                    // Ставим flash-модели 3.0 в приоритет
                    available.sort((a, b) => {
                        const score = name => (name.includes('3.0-flash') ? 3 : name.includes('flash') ? 2 : 1);
                        return score(b) - score(a);
                    });
                    candidateModels = [...new Set(['gemini-3.0-flash', ...available])];
                }
            }
        } catch (e) {}

        let successData = null;
        let lastErrorMsg = '';

        for (const modelName of candidateModels) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts }] })
                    }
                );

                const data = await response.json();

                if (response.ok && data.candidates) {
                    successData = data;
                    break;
                }

                lastErrorMsg = data.error?.message || `Ошибка (${response.status})`;

                if (response.status === 503 || response.status === 429) {
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    break; // Если 404 или 400 — мгновенно переходим к следующей доступной модели
                }
            }
            if (successData) break;
        }

        if (!successData) {
            throw new Error(lastErrorMsg);
        }

        const fullText = successData.candidates?.[0]?.content?.parts?.[0]?.text || 'Конспект успешно создан.';
        const lines = fullText.split('\n').filter(l => l.trim() !== '');
        const title = lines[0]?.replace(/^[#*-\s]+/, '') || `Урок (${subject})`;
        const summary = lines.slice(1).join('\n') || fullText;

        const newLesson = {
            id: Date.now(),
            subject,
            title,
            summary,
            slides: Array.isArray(slides) ? slides.slice(0, 4) : [],
            time: time || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        };

        // Сохраняем на сервере Vercel (доступно сразу всем устройствам)
        const updatedLessons = saveSharedLesson(newLesson);

        // Дублируем в Supabase, если подключена
        if (supabaseUrl && supabaseKey) {
            try {
                await fetch(`${supabaseUrl}/rest/v1/lessons`, {
                    method: 'POST',
                    headers: {
                        'apikey': supabaseKey,
                        'Authorization': `Bearer ${supabaseKey}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=minimal'
                    },
                    body: JSON.stringify(newLesson)
                });
            } catch (e) {}
        }

        return res.status(200).json({ title, summary, lesson: newLesson, lessons: updatedLessons });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
