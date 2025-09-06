module.exports = ({ env }) => ({
  email: {
    config: {
      provider: "sendgrid",
      providerOptions: {
        apiKey: env("SENDGRID_API_KEY"),
      },
      settings: {
        defaultFrom: "no-reply@almacencriollo.com",
        defaultReplyTo: "support@almacencriollo.com",
      },
    },
  },
});