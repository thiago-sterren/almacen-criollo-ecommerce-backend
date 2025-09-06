'use strict'

/**
 * order service
 */

const { createCoreService } = require('@strapi/strapi').factories

module.exports = createCoreService("api::order.order", ({ strapi }) => ({
  async restockProducts(order) {
    const db = strapi.db.connection
    let products = order.products

    if (typeof products === "string") {
        try {
            products = JSON.parse(products)
        } catch (err) {
            console.error("❌ Error parseando products:", err)
            return
        }
    }
    await db.transaction(async (trx) => {
      for (const item of products) {
        const qty = Number(item.quantity) || 0 // seguridad adicional
        if (qty <= 0) continue // ignorar cantidades inválidas

        try {
          const product = await strapi.entityService.findOne(
            "api::product.product",
            item.id,
            { fields: ["stock"] },
            { transacting: trx }
          )
          const currentStock = product.stock || 0
          const newStock = currentStock + qty
        
          await strapi.entityService.update(
              "api::product.product",
              item.id,
              { data: { stock: newStock } },
              { transacting: trx }
          )
          console.log(`✅ Stock restaurado para ${item.productName}: +${qty} (Nuevo stock: ${newStock})`)
        } catch (error) {
            console.error(`❌ Error actualizando ${item.productName}:`, error)
        }
      }
    })
  },
}))