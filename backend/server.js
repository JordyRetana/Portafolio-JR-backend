import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { Resend } from 'resend'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 4000
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant'
const CHAT_TIMEOUT_MS = 12000
const chatCache = new Map()

app.use(cors())
app.use(express.json())

const resend = new Resend(process.env.RESEND_API_KEY)

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Servidor funcionando'
  })
})

function getPortfolioContext(language = 'es') {
  if (language === 'en') {
    return `
You are Jordy's portfolio assistant. Speak naturally, briefly, and in English.

Known facts:
- Name: Jordy Jesus Retana Mendez.
- Location: Hatillo, San Jose, Costa Rica.
- Profile: advanced Systems Engineering student and Full Stack developer.
- Education: Bachelor Degree in Systems Engineering at Universidad Fidelitas, fourth-year student, studying since 2023.
- Stack: JavaScript, C#, Java, SQL, React, .NET, Spring Boot, Node.js, REST APIs, PostgreSQL, Oracle, Git, basic Docker.
- Experience: software projects since 2023; professional experience at CooperVision as Quality Department Assistant from April 2022 to January 2023.
- Projects: BibliotecaApp, PulseOps IncidentHub, FieldLens ResearchHub, EcoTrack Analytics, ReservaPro Studio, Tutorías JR, hand recognition with Python/OpenCV/MediaPipe, Pool, Snake, Kirby, Java client-server sales system, SC502, and more.
- Tutoring: Jordy offers 1-on-1 programming tutoring and small groups. He teaches programming logic, Python, JavaScript, Java, C# .NET, SQL, React, Node.js, web development, APIs and databases.
- Contact: email jretanamendez@gmail.com, WhatsApp +506 8713-8971, GitHub https://github.com/JordyRetana, LinkedIn https://www.linkedin.com/in/jordyretana.

Rules:
- If the user asks a simple question, answer in 1 or 2 short sentences.
- If the user asks for detail, give a little more, but do not write huge paragraphs.
- If a detail is not known, say you do not have that exact detail and offer a useful related fact.
- Do not invent private information, exact salary, age, or availability beyond the facts above.
`.trim()
  }

  return `
Sos el asistente del portafolio de Jordy. Habla natural, breve y en español.

Datos conocidos:
- Nombre: Jordy Jesus Retana Mendez.
- Ubicacion: Hatillo, San Jose, Costa Rica.
- Perfil: estudiante avanzado de Ingenieria en Sistemas y desarrollador Full Stack.
- Educacion: Bachillerato en Ingenieria en Sistemas en Universidad Fidelitas, cuarto año, estudia desde 2023.
- Stack: JavaScript, C#, Java, SQL, React, .NET, Spring Boot, Node.js, APIs REST, PostgreSQL, Oracle, Git, Docker basico.
- Experiencia: proyectos de software desde 2023; experiencia profesional previa en CooperVision como asistente del Departamento de Calidad de abril 2022 a enero 2023.
- Proyectos: BibliotecaApp, PulseOps IncidentHub, FieldLens ResearchHub, EcoTrack Analytics, ReservaPro Studio, Tutorías JR, reconocimiento de mano con Python/OpenCV/MediaPipe, Pool, Snake, Kirby, sistema cliente-servidor en Java, SC502 y mas.
- Tutorias: Jordy da tutorias 1 a 1 y grupos pequeños. Enseña logica de programacion, Python, JavaScript, Java, C# .NET, SQL, React, Node.js, desarrollo web, APIs y bases de datos.
- Contacto: correo jretanamendez@gmail.com, WhatsApp +506 8713-8971, GitHub https://github.com/JordyRetana, LinkedIn https://www.linkedin.com/in/jordyretana.

Reglas:
- Si la pregunta es simple, responde en 1 o 2 frases cortas.
- Si pide detalle, da un poco mas, pero sin parrafos enormes.
- Si no sabes un dato exacto, dilo con honestidad y ofrece un dato relacionado util.
- No inventes informacion privada, edad, salario exacto ni disponibilidad fuera de los datos anteriores.
`.trim()
}

async function callGroqChat({ message, language }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS)

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.45,
        max_tokens: 260,
        messages: [
          {
            role: 'system',
            content: getPortfolioContext(language)
          },
          {
            role: 'user',
            content: message
          }
        ]
      })
    })

    const data = await response.json().catch(() => null)

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: data?.error?.message || 'Groq request failed'
      }
    }

    const answer = data?.choices?.[0]?.message?.content?.trim()

    if (!answer) {
      return { ok: false, status: 502, message: 'Groq returned an empty response' }
    }

    return { ok: true, answer }
  } catch (error) {
    if (error.name === 'AbortError') {
      return { ok: false, status: 504, message: 'Groq request timed out' }
    }

    return { ok: false, status: 502, message: error.message || 'Groq request failed' }
  } finally {
    clearTimeout(timeout)
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ ok: false, status: 504, message: 'AI request timed out' })
      }, ms)
    })
  ])
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, language = 'es' } = req.body
    const cleanMessage = String(message || '').trim().slice(0, 700)
    const cleanLanguage = language === 'en' ? 'en' : 'es'

    if (!cleanMessage) {
      return res.status(400).json({
        ok: false,
        fallback: true,
        message: 'Mensaje requerido'
      })
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({
        ok: false,
        fallback: true,
        message: 'GROQ_API_KEY no configurada'
      })
    }

    const cacheKey = `${cleanLanguage}:${cleanMessage.toLowerCase()}`
    const cached = chatCache.get(cacheKey)

    if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) {
      return res.json({
        ok: true,
        provider: 'groq-cache',
        answer: cached.answer
      })
    }

    const result = await withTimeout(
      callGroqChat({
        message: cleanMessage,
        language: cleanLanguage
      }),
      CHAT_TIMEOUT_MS + 2000
    )

    if (!result.ok) {
      return res.status(result.status || 502).json({
        ok: false,
        fallback: true,
        message: result.message
      })
    }

    chatCache.set(cacheKey, {
      answer: result.answer,
      createdAt: Date.now()
    })

    if (chatCache.size > 80) {
      const firstKey = chatCache.keys().next().value
      chatCache.delete(firstKey)
    }

    return res.json({
      ok: true,
      provider: 'groq',
      answer: result.answer
    })
  } catch (error) {
    console.error('Error en /api/chat:', error)

    return res.status(500).json({
      ok: false,
      fallback: true,
      message: 'No se pudo responder con IA'
    })
  }
})

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, subject, budget, message, newsletter } = req.body

    if (!name || !email || !subject || !message) {
      return res.status(400).json({
        ok: false,
        message: 'Faltan campos obligatorios'
      })
    }

    const subjectMap = {
      project: 'Propuesta de proyecto',
      collaboration: 'Colaboración',
      consulting: 'Consultoría',
      job: 'Oportunidad laboral',
      other: 'Otro asunto'
    }

    const readableSubject = subjectMap[subject] || subject

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2>Nuevo mensaje desde el portafolio</h2>
        <p><strong>Nombre:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Asunto:</strong> ${readableSubject}</p>
        <p><strong>Presupuesto:</strong> ${budget || 'No especificado'}</p>
        <p><strong>Newsletter:</strong> ${newsletter ? 'Sí' : 'No'}</p>
        <hr />
        <p><strong>Mensaje:</strong></p>
        <p>${String(message).replace(/\n/g, '<br />')}</p>
      </div>
    `

    const data = await resend.emails.send({
      from: 'Portafolio JR <onboarding@resend.dev>',
      to: ['jretanamendez@gmail.com'],
      reply_to: email,
      subject: `Nuevo mensaje desde Portafolio JR: ${readableSubject}`,
      html
    })

    return res.json({
      ok: true,
      message: 'Correo enviado correctamente',
      id: data?.data?.id || null
    })
  } catch (error) {
    console.error('Error enviando correo:', error)

    return res.status(500).json({
      ok: false,
      message: 'No se pudo enviar el correo'
    })
  }
})

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`)
})
