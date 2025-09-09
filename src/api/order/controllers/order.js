"use strict"

// Para envío de mails
//const { Resend } = require("resend")

// Importar la clase de Mercado Pago
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago")

// Crear la instancia con el Access Token
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
})

const paymentClient = new Payment(client)

const crypto = require("crypto")

//const resend = new Resend(process.env.RESEND_API_KEY)

function formatPrice(price) {
    const priceFormated = new Intl.NumberFormat("es-AR", {
        style: "currency",
        currency: "ARS"
    })

    const finalPrice = priceFormated.format(price)

    return finalPrice
}

module.exports = {  
  async create(ctx) {
    try {
      const { 
        firstName,
        lastName,
        email,
        phone,
        deliveryMethod,
        address,
        paymentMethod,
        products,
        orderStatus,
        mercadoPagoId,
        orderToken,
        totalPrice,
      } = ctx.request.body.data || {} // Recibimos desde el fetch del front

      // 1. Crear la orden en la base de datos
      const order = await strapi.db.query("api::order.order").create({
        data: {
          firstName,
          lastName,
          email,
          phone,
          deliveryMethod,
          address,
          paymentMethod,
          orderStatus,
          mercadoPagoId,
          orderToken,
          totalPrice,
          products,
        },
      })

      
      // 2. Si el método es efectivo -> devolver confirmación
      if (paymentMethod === "cash") {
        // (async function () {
        //   const { data, error } = await resend.emails.send({
        //     from: 'Acme <onboarding@resend.dev>',
        //     to: ['almacencriolloecommerce@gmail.com'],
        //     subject: 'Compra realizada',
        //     html: `<strong>¡Gracias por elegirnos, ${firstName} ${lastName}! ${deliveryMethod === "pickup" ?
        //        `Ya podés pasar a realizar el pago de ${formatPrice(totalPrice)} por nuestro local en J. B. Justo 361 y retirar tu orden.` :
        //        `Te contactaremos para acordar detalles de la entrega a realizar en ${address}. Total a pagar en el momento de entrega: ${formatPrice(totalPrice)}.`
        //       }</strong>`,
        //   })

        //   if (error) {
        //     return console.error({ error })
        //   }

        //   console.log({ data })
        // })()

        ctx.status = 201
        return {
          orderId: order.id,
          orderToken: orderToken,
          message: `Pedido confirmado, nos contactaremos para coordinar el pago en efectivo.`,
        }
      }
      
      // 3. Si paga con Mercado Pago -> crear preferencia
      if (paymentMethod === "mercado_pago") {
        const preference = {
          items: [
            {
              title: "Total pedido",
              unit_price: Number(totalPrice),
              quantity: 1,
              currency_id: "ARS",
            }
          ],
          payer: {
            name: `${firstName} ${lastName}`,
            email,
          },
          back_urls: {
            success: `${process.env.FRONTEND_URL}/order/${orderToken}`,
            failure: `${process.env.FRONTEND_URL}`,
            pending: `${process.env.FRONTEND_URL}/order/${orderToken}`,
          },
          auto_return: "approved",
          external_reference: String(orderToken)
        }
        
        // Instanciar el módulo de preferencias
        const preferenceClient = new Preference(client)
        let mpResponse
        try {
          mpResponse = await preferenceClient.create({ body: preference })
        } catch (err) {
          console.error("Error creando preferencia en MP:", err)
          ctx.throw(500, "Error creando preferencia en Mercado Pago")
        }

        // Guardar el id de MP en la orden
        await strapi.db.query("api::order.order").update({
          where: { id: order.id },
          data: { mercadoPagoId: mpResponse.id },
        })

        ctx.status = 201
        return {
          id: order.id,
          orderToken: orderToken,
          init_point: mpResponse.init_point,
          message: "Pedido confirmado. Te estamos redirigiendo a la pasarela de pago de Mercado Pago."
        }
      }

      ctx.status = 400
      ctx.badRequest("Método de pago no soportado")
    } catch (error) {
      console.error("Error creando la orden:", error)
      ctx.throw(500, "Error creando la orden")
    }
  },

  // Webhook de Mercado Pago
  async mercadoPagoWebhook(ctx) {
    try {
      const secret = process.env.MP_WEBHOOK_SECRET
      const signature = ctx.request.headers['x-signature'] || ctx.request.headers['x-hub-signature-256']
      const requestId = ctx.request.headers['x-request-id']
      const body = ctx.request.body

      console.log("Headers recibidos:", { signature, requestId });
      console.log("Body recibido:", body);

      // dividir x-signature (en partes v1= y ts=)
      const signatureParts = signature?.split(',')
      const timestampPart = signatureParts?.find(part => part.startsWith('ts='))?.split('=')[1]
      const signatureV1 = signatureParts?.find(part => part.startsWith('v1='))?.split('=')[1]
      if (!signatureV1 || !timestampPart) {
        console.warn('⚠️ Firma v1 o timestamp no encontrados en x-signature')
        return ctx.unauthorized('Firma inválida')
      }

      // Construyo el manifest
      const dataId = body?.data?.id?.toString().toLowerCase() // si es alfanumérico, debe ir en minúsculas
      let manifest = `id:${dataId};ts:${timestampPart};`
      if (requestId) {
        manifest = `id:${dataId};request-id:${requestId};ts:${timestampPart};`
      }

      console.log("Manifest generado:", manifest);

      // Genera la firma local
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(manifest)
        .digest('hex')
      
      const isValid = crypto.timingSafeEqual(
        Buffer.from(signatureV1, 'utf8'),
        Buffer.from(expectedSignature, 'utf8')
      )

      console.log("Firma esperada:", expectedSignature);
      console.log("Firma válida:", isValid);

      if (!isValid) {
        console.warn('⚠️ Firma de webhook inválida')
        return ctx.unauthorized('Firma inválida')
      }

      const { type, data } = body
      if (!type || !data?.id) {
        console.warn("⚠️ Tipo o ID de datos no encontrados en el body");
        return ctx.badRequest("Webhook inválido")
      }

      console.log("Consultando pago con ID:", data.id);
      let payment
      try {
        // 🔹 Usamos el PaymentClient del nuevo SDK
        payment = await paymentClient.get({ id: data.id })
        console.log("Pago obtenido:", payment.status);
      } catch (error) {
        console.error("❌ Error al consultar pago:", error)
        return ctx.badRequest("Error al consultar el pago")
      }

      if (!payment) {
        console.warn("⚠️ No se pudo obtener el pago");
        return ctx.badRequest("No se pudo obtener el pago")
      }

      // const mercadoPagoId = payment.id
      // console.log("Buscando orden con mercadoPagoId:", mercadoPagoId);
      // Buscar la orden en Strapi usando external_reference (=orderToken) desde el pago
      const externalReference = payment.external_reference
      if (!externalReference) {
        console.warn("⚠️ external_reference no encontrado en el pago");
        return ctx.badRequest("No se pudo identificar la orden");
      }

      console.log("Buscando orden con external_reference:", externalReference);
      const orders = await strapi.db.query("api::order.order").findMany({
        //where: { mercadoPagoId },
        where: { orderToken: externalReference } 
      })

      if (!orders.length) {
        console.warn("⚠️ Orden no encontrada con orderToken:", externalReference);
        return ctx.notFound("Orden no encontrada")
      }

      const order = orders[0]
      console.log("Orden encontrada:", order.id);

      // Actualizar mercadoPagoId con el payment.id
      if (order.mercadoPagoId !== payment.id) {
        await strapi.db.query("api::order.order").update({
          where: { id: order.id },
          data: { mercadoPagoId: payment.id },
        });
        console.log("Actualizado mercadoPagoId a:", payment.id);
      }

      // Mapeo de estados Mercado Pago → sistema interno
      const statusMap = {
        approved: "paid",
        pending: "pending",
        in_process: "pending",
        cancelled: "cancelled",
        expired: "cancelled",
      }

      const orderStatus = statusMap[payment.status] || "pending"

      // Idempotencia: Si el estado ya está actualizado, no hacer nada
      if (order.orderStatus === orderStatus) {
        console.log("Estado ya actualizado, no se realiza cambio:", orderStatus);
        ctx.send({ received: true })
        return
      }

      console.log("Actualizando estado de la orden a:", orderStatus);
      // Actualizar estado de la orden
      await strapi.db.query("api::order.order").update({
        where: { id: order.id },
        data: { orderStatus },
      })

      ctx.send({ received: true })
    } catch (error) {
      console.error("💥 Error en webhook Mercado Pago:", error)
      ctx.throw(500, "Error procesando webhook")
    }
  },

  async find(ctx) {
    try {
      const entities = await strapi.entityService.findMany("api::order.order", ctx.query)
      return entities
    } catch (error) {
      console.error("Error al obtener órdenes:", error)
      ctx.throw(500, "Error al obtener las órdenes")
    }
  },
}