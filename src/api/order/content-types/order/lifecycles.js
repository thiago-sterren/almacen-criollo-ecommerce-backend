const { Resend } = require("resend")

const resend = new Resend(process.env.RESEND_API_KEY)

async function sendEmail(to, subject, html) {
  try {
    await resend.emails.send({
      from: 'Almacén Criollo <noreply@almacencriollosunchales.com>',
      to,
      subject,
      html
    })
  } catch (error) {
    console.error("Error enviando email: ", error)
  }
}

module.exports = {
  async beforeCreate(event) {
    try {
      const { data } = event.params

      // 🔐 Validación de token único
      if (!data.orderToken) throw new Error("Falta el token de orden.")

      const existing = await strapi.entityService.findMany("api::order.order", {
        filters: { orderToken: data.orderToken },
      })
      if (existing.length > 0) throw new Error("Pedido duplicado detectado.")

      // 📋 Validación de campos personales
      const requiredFields = ["firstName", "lastName", "email", "phone", "deliveryMethod", "paymentMethod", "products", "totalPrice"]
      for (const field of requiredFields) {
        if (!data[field]) throw new Error(`El campo '${field}' es obligatorio.`)
      }

      const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      if (!isValidEmail(data.email)) throw new Error("Email inválido.")

      const isValidPhone = (phone) => /^[0-9\s\-]{8,}$/.test(phone)
      if (!isValidPhone(data.phone)) throw new Error("Teléfono inválido.")

      const isValidAddress = (address) => {
        const lengthValid = address.length >= 7 && address.length <= 50
        const containsStreetAndNumber = /[A-Za-zÁÉÍÓÚáéíóúÑñ\s]+\s\d{1,5}/.test(address)
        return lengthValid && containsStreetAndNumber
      }
      if (data.deliveryMethod === "shipping" && !isValidAddress(data.address)) {
        throw new Error("Dirección inválida para envío.")
      }

      // 🛒 Validación de productos
      if (!Array.isArray(data.products) || data.products.length === 0) {
        throw new Error("La orden debe incluir productos.")
      }

      const slugs = data.products.map((item) => item.slug)
      const products = await strapi.entityService.findMany("api::product.product", {
        filters: { slug: { $in: slugs } },
        fields: ["slug", "stock", "productName", "price"],
      })

      for (const item of data.products) {
        if (
          typeof item.quantity !== "number" ||
          !Number.isInteger(item.quantity) ||
          item.quantity <= 0
        ) {
          throw new Error(`Cantidad inválida para el producto con slug ${item.slug}.`)
        }

        const product = products.find((p) => p.slug === item.slug)
        if (!product) {
          throw new Error(`Producto con slug ${item.slug} no encontrado o no publicado.`)
        }

        if (typeof product.stock !== "number") {
          throw new Error(`El producto ${product.productName} no tiene stock definido.`)
        }

        if (item.quantity > product.stock) {
          throw new Error(`Stock insuficiente para ${product.productName}. Disponible: ${product.stock}, solicitado: ${item.quantity}`)
        }
      }
    } catch (err) {
      console.error("🧨 Error completo en beforeCreate:", err)
      throw new Error(err?.message || "Error interno al validar la orden.")
    }
  },
  
  async afterCreate(event) {
    try {
      const { result } = event

      if (!result.products || !Array.isArray(result.products)) {
        console.warn("⚠️ La orden creada no contiene productos.")
        return
      }

      const db = strapi.db.connection

      await db.transaction(async (trx) => {
        const slugs = result.products.map((item) => item.slug)

        const products = await strapi.entityService.findMany("api::product.product", {
          filters: { slug: { $in: slugs } },
          fields: ["id", "slug", "stock", "productName"],
        }, { transacting: trx })

        for (const item of result.products) {
          const product = products.find((p) => p.slug === item.slug)

          if (!product) {
            console.warn(`⚠️ Producto con slug ${item.slug} no encontrado para actualizar stock.`)
            continue
          }

          const newStock = product.stock - item.quantity

          if (newStock < 0) {
            console.warn(`⚠️ Stock negativo para ${product.slug}. Se omite actualización.`)
            continue
          }

          await strapi.entityService.update("api::product.product", product.id, {
            data: { stock: newStock },
          }, { transacting: trx })

          // Enviar notificación por correo para cuando el stock es menor a 5
          if (newStock <= 5 && newStock > 0) {
            //console.warn(`⚠️ Stock bajo para ${product.productName}: ${newStock} unidades restantes.`)
            const emailHTML = `
            <div>
              <strong>¡Stock bajo para ${product.productName}!</strong>
              <p>Quedan apenas ${newStock} unidades de este producto en stock.</p>
            </div>
            `
            sendEmail(
              'almacencriolloecommerce@gmail.com',
              'Quedan pocas unidades para este producto',
              emailHTML
            )
          }
          // Enviar notificación por correo para cuando el stock es 0
          if (newStock = 0) {
            const emailHTML = `
            <div>
              <strong>¡Te quedaste sin stock para ${product.productName}!</strong>
              <p>Ya no quedan unidades de este producto en el inventario.</p>
            </div>
            `
            sendEmail(
              'almacencriolloecommerce@gmail.com',
              'No hay unidades restantes para este producto',
              emailHTML
            )
          }
        }
      })

    } catch (err) {
      console.error("🧨 Error en afterCreate:", err)
      throw err
    }
  },
  async afterUpdate(event) {
    const { result, params } = event

    // Si el orderStatus se actualiza (por webhook de MP o manualmente) a "cancelled"
    if (result.orderStatus === "cancelled") {
      await strapi.service("api::order.order").restockProducts(result)
      await sendEmail(
        result.email,
        `Tu orden #${result.id} ha sido cancelada`,
        `<div>
          <p>Lo sentimos, tu orden ha sido cancelada. Ante cualquier duda o reclamo, contactanos vía WhatsApp o Instagram.</p>
          <br><br>
          <p>Por favor, no responder a esta dirección de email. Ante cualquier duda, contactanos a nuestro WhatsApp o Instagram que podés encontrar en el pie de la misma página web en la que hiciste esta compra :)</p> 
        </div>`
      )
    }
  }
}