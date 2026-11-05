export const config = {
    api: {
        bodyParser: {
            sizeLimit: '20mb',
        },
    },
};

// Выносим название модели в константу. 
// gemini-1.5-flash — это самая стабильная бесплатная мультимодальная модель на текущий момент.
const MODEL_NAME = 'gemini-1.5-flash';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Только POST запросы' });

    try {
        const { audioBase64, subject, slides } = req.body;
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

        // Прикрепляем аудио, если оно не пустое
        if (audioBase64 && audioBase64.length > 100) {
            // Защита: если вдруг пришел data:audio/webm;base64,..., отрезаем префикс
            const cleanAudioBase64 = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;
            parts.push({
                inlineData: {
                    mimeType: 'audio/webm',
                    data: cleanAudioBase64
                }
            });
        }

        // Прикрепляем до 4 ключевых слайдов урока
        if (Array.isArray(slides) && slides.length > 0) {
            const selectedSlides = slides.slice(0, 4);
            for (const slideDataUrl of selectedSlides) {
                if (typeof slideDataUrl === 'string' && slideDataUrl.includes(',')) {
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
        }

        let successData = null;
        let lastErrorMsg = '';

        for (let attempt = 1; attempt <= 4; attempt++) {
            // Формируем URL строго с проверенной моделью
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${geminiKey}`;
            
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    contents: [{ parts }] 
                })
            });

            const data = await response.json();

            if (response.ok && data.candidates) {
                successData = data;
                break;
            }

            lastErrorMsg = data.error?.message || `Ошибка сервера (${response.status})`;
            
            // Логируем ошибку в консоль Vercel для отладки
            console.error(`[Gemini API Error] Attempt ${attempt}:`, lastErrorMsg, data.error);

            // Если сервер занят (503 High Demand или 429), ждем и пробуем снова
            if (response.status === 503 || response.status === 429) {
                await new Promise(r => setTimeout(r, 2500));
            } else {
                break; // При других ошибках (например, 400 Bad Request) нет смысла повторять
            }
        }

        if (!successData) {
            throw new Error(lastErrorMsg || 'Не удалось получить ответ от ИИ после нескольких попыток');
        }

        const fullText = successData.candidates?.[0]?.content?.parts?.[0]?.text || 'Конспект успешно создан.';
        const lines = fullText.split('\n').filter(l => l.trim() !== '');
        
        // Очищаем первую строку от любых маркеров, если ИИ всё же их добавил
        const title = lines[0]?.replace(/^[#*-\s]+/, '').trim() || `Урок (${subject})`;
        const summary = lines.slice(1).join('\n').trim() || fullText;

        return res.status(200).json({ title, summary });
        
    } catch (err) {
        console.error('[API Handler Critical Error]:', err);
        return res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
    }
}
