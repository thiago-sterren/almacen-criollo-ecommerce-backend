module.exports = {
  async beforeCreate(event) {
    try {
      const { data } = event.params

      console.log("🔍 Validando pedido con orderToken:", data.orderToken, "a las", new Date().toISOString())

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

      console.log("✅ Pedido validado y listo para crear:", data.products)
    } catch (err) {
      console.error("🧨 Error completo en beforeCreate:", err)
      throw new Error(err?.message || "Error interno al validar la orden.")
    }
  },
  
  async afterCreate(event) {
    try {
      const { result } = event

      console.log(`📦 Pedido creado con ID: ${result.id} y token: ${result.orderToken}`)

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

          // Notificar si el stock está bajo
          if (newStock <= 5) {
            console.warn(`⚠️ Stock bajo para ${product.productName}: ${newStock} unidades restantes.`)
            // Opcional: enviar notificación por correo o a un sistema de monitoreo
          }

          console.log(`✅ Stock actualizado para ${product.slug}: ${product.stock} → ${newStock}`)
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
      console.log(`🚫 Orden ${result.id} cancelada, stock restaurado`)
    }
  }
}