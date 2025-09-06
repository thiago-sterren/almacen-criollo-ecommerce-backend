"use strict"

module.exports = {
  routes: [
    // Crear orden
    {
      method: "POST",
      path: "/orders",
      handler: "order.create",
      config: { auth: false },
    },

    // Webhook Mercado Pago
    {
      method: "POST",
      path: "/orders/mercado-pago-webhook",
      handler: "order.mercadoPagoWebhook",
      config: { auth: false },
    },

    // Obtener lista de órdenes
    {
      method: "GET",
      path: "/orders",
      handler: "order.find",
      config: { auth: false },
    },
  ],
}