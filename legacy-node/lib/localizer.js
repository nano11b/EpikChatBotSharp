const MESSAGES = Object.freeze({
  en: {
    commands: "Commands",
    permission: "This command requires the {role} role.",
    disabled: "That feature is disabled in this room.",
    profile: "Profile: language {language}, timezone {timezone}, concise {concise}.",
  },
  es: {
    commands: "Comandos",
    permission: "Este comando requiere el rol {role}.",
    disabled: "Esa función está desactivada en esta sala.",
    profile: "Perfil: idioma {language}, zona horaria {timezone}, conciso {concise}.",
  },
});

function translate(language, key, variables = {}) {
  const template = MESSAGES[language]?.[key] || MESSAGES.en[key] || key;
  return template.replace(/\{([a-z]+)\}/gi, (_match, name) => String(variables[name] ?? ""));
}

module.exports = { MESSAGES, translate };
