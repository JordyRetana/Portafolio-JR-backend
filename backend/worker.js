const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const RESEND_API_URL = 'https://api.resend.com/emails'
const CHAT_TIMEOUT_MS = 8000
const CHAT_WARMUP_TIMEOUT_MS = 6000
const API_VERSION = 'cloudflare-worker-2026-07-24'
const chatCache = new Map()

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    }
  })
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

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
- Projects: BibliotecaApp, PulseOps IncidentHub, FieldLens ResearchHub, EcoTrack Analytics, ReservaPro Studio, Tutorias JR, hand recognition with Python/OpenCV/MediaPipe, Pool, Snake, Kirby, Java client-server sales system, SC502, and more.
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
Sos el asistente del portafolio de Jordy. Habla natural, breve y en espanol.

Datos conocidos:
- Nombre: Jordy Jesus Retana Mendez.
- Ubicacion: Hatillo, San Jose, Costa Rica.
- Perfil: estudiante avanzado de Ingenieria en Sistemas y desarrollador Full Stack.
- Educacion: Bachillerato en Ingenieria en Sistemas en Universidad Fidelitas, cuarto ano, estudia desde 2023.
- Stack: JavaScript, C#, Java, SQL, React, .NET, Spring Boot, Node.js, APIs REST, PostgreSQL, Oracle, Git, Docker basico.
- Experiencia: proyectos de software desde 2023; experiencia profesional previa en CooperVision como asistente del Departamento de Calidad de abril 2022 a enero 2023.
- Proyectos: BibliotecaApp, PulseOps IncidentHub, FieldLens ResearchHub, EcoTrack Analytics, ReservaPro Studio, Tutorias JR, reconocimiento de mano con Python/OpenCV/MediaPipe, Pool, Snake, Kirby, sistema cliente-servidor en Java, SC502 y mas.
- Tutorias: Jordy da tutorias 1 a 1 y grupos pequenos. Ensena logica de programacion, Python, JavaScript, Java, C# .NET, SQL, React, Node.js, desarrollo web, APIs y bases de datos.
- Contacto: correo jretanamendez@gmail.com, WhatsApp +506 8713-8971, GitHub https://github.com/JordyRetana, LinkedIn https://www.linkedin.com/in/jordyretana.

Reglas:
- Si la pregunta es simple, responde en 1 o 2 frases cortas.
- Si pide detalle, da un poco mas, pero sin parrafos enormes.
- Si no sabes un dato exacto, dilo con honestidad y ofrece un dato relacionado util.
- No inventes informacion privada, edad, salario exacto ni disponibilidad fuera de los datos anteriores.
`.trim()
}

async function withTimeout(promise, ms) {
  let timeoutId
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ ok: false, status: 504, message: 'AI request timed out' })
    }, ms)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callGroqChat({ env, message, language, maxTokens = 220 }) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: env.GROQ_MODEL || 'llama-3.1-8b-instant',
      temperature: 0.45,
      max_tokens: maxTokens,
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
}

async function handleChat(request, env) {
  const body = await readJson(request)
  const cleanMessage = String(body.message || '').trim().slice(0, 700)
  const cleanLanguage = body.language === 'en' ? 'en' : 'es'

  if (!cleanMessage) {
    return json({ ok: false, fallback: true, message: 'Mensaje requerido' }, 400)
  }

  if (!env.GROQ_API_KEY) {
    return json({ ok: false, fallback: true, message: 'GROQ_API_KEY no configurada' }, 503)
  }

  const cacheKey = `${cleanLanguage}:${cleanMessage.toLowerCase()}`
  const cached = chatCache.get(cacheKey)

  if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) {
    return json({
      ok: true,
      provider: 'groq-cache',
      answer: cached.answer
    })
  }

  const result = await withTimeout(
    callGroqChat({
      env,
      message: cleanMessage,
      language: cleanLanguage
    }),
    CHAT_TIMEOUT_MS + 2000
  )

  if (!result.ok) {
    return json({ ok: false, fallback: true, message: result.message }, result.status || 502)
  }

  chatCache.set(cacheKey, {
    answer: result.answer,
    createdAt: Date.now()
  })

  if (chatCache.size > 80) {
    const firstKey = chatCache.keys().next().value
    chatCache.delete(firstKey)
  }

  return json({
    ok: true,
    provider: 'groq',
    answer: result.answer
  })
}

async function handleWarmup(env) {
  if (!env.GROQ_API_KEY) {
    return json({ ok: false, message: 'GROQ_API_KEY no configurada' }, 503)
  }

  const result = await withTimeout(
    callGroqChat({
      env,
      message: 'Reply with only: ok',
      language: 'en',
      maxTokens: 8
    }),
    CHAT_WARMUP_TIMEOUT_MS + 1000
  )

  if (!result.ok) {
    return json({ ok: false, message: result.message }, result.status || 502)
  }

  return json({
    ok: true,
    provider: 'groq',
    warmed: true
  })
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

async function handleContact(request, env) {
  const body = await readJson(request)
  const { name, email, subject, budget, message, newsletter } = body

  if (!name || !email || !subject || !message) {
    return json({ ok: false, message: 'Faltan campos obligatorios' }, 400)
  }

  if (!env.RESEND_API_KEY) {
    return json({ ok: false, message: 'RESEND_API_KEY no configurada' }, 503)
  }

  const subjectMap = {
    project: 'Propuesta de proyecto',
    collaboration: 'Colaboracion',
    consulting: 'Consultoria',
    job: 'Oportunidad laboral',
    other: 'Otro asunto'
  }

  const readableSubject = subjectMap[subject] || subject
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
      <h2>Nuevo mensaje desde el portafolio</h2>
      <p><strong>Nombre:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Asunto:</strong> ${escapeHtml(readableSubject)}</p>
      <p><strong>Presupuesto:</strong> ${escapeHtml(budget || 'No especificado')}</p>
      <p><strong>Newsletter:</strong> ${newsletter ? 'Si' : 'No'}</p>
      <hr />
      <p><strong>Mensaje:</strong></p>
      <p>${escapeHtml(message).replace(/\n/g, '<br />')}</p>
    </div>
  `

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'Portafolio JR <onboarding@resend.dev>',
      to: [env.CONTACT_TO_EMAIL || 'jretanamendez@gmail.com'],
      reply_to: email,
      subject: `Nuevo mensaje desde Portafolio JR: ${readableSubject}`,
      html
    })
  })

  const data = await response.json().catch(() => null)

  if (!response.ok) {
    return json({ ok: false, message: data?.message || 'No se pudo enviar el correo' }, response.status)
  }

  return json({
    ok: true,
    message: 'Correo enviado correctamente',
    id: data?.id || null
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({
        ok: true,
        message: 'Servidor funcionando en Cloudflare Workers',
        version: API_VERSION,
        chat: true,
        groqConfigured: Boolean(env.GROQ_API_KEY)
      })
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env)
    }

    if (url.pathname === '/api/chat/warmup' && request.method === 'GET') {
      return handleWarmup(env)
    }

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      return handleContact(request, env)
    }

    return json({ ok: false, message: 'Not found' }, 404)
  }
}
