import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { Resend } from 'resend'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 4000

app.use(cors())
app.use(express.json())

const resend = new Resend(process.env.RESEND_API_KEY)

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Servidor funcionando'
  })
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