// ============================================================
// CARCASH · VALIDATORS
// Validación de datos argentinos (DNI, CUIT, patente, teléfono)
// ============================================================

/**
 * Valida DNI argentino (7-8 dígitos)
 */
export function isValidDNI(dni) {
  if (!dni) return false;
  const digits = String(dni).replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 8;
}

/**
 * Valida CUIT argentino con dígito verificador
 * Formato: 11 dígitos. Algoritmo módulo 11.
 */
export function isValidCUIT(cuit) {
  if (!cuit) return false;
  const digits = String(cuit).replace(/\D/g, '');
  if (digits.length !== 11) return false;

  const mults = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(digits[i], 10) * mults[i];
  }
  const mod = sum % 11;
  let dv = 11 - mod;
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === parseInt(digits[10], 10);
}

/**
 * Valida patente argentina:
 *   - Vieja: ABC123 (3 letras + 3 números)
 *   - Nueva (Mercosur): AB123CD (2 letras + 3 números + 2 letras)
 */
export function isValidPlate(plate) {
  if (!plate) return false;
  const clean = String(plate).toUpperCase().replace(/\s|-/g, '');
  return /^[A-Z]{3}\d{3}$/.test(clean) || /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(clean);
}

/**
 * Valida teléfono argentino (mínimo 10 dígitos, opcionalmente con +54)
 */
export function isValidPhone(phone) {
  if (!phone) return false;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13;
}

/**
 * Valida email
 */
export function isValidEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

/**
 * Valida año razonable de auto (1950 - año en curso + 1)
 */
export function isValidCarYear(year) {
  const y = parseInt(year, 10);
  if (isNaN(y)) return false;
  const current = new Date().getFullYear();
  return y >= 1950 && y <= current + 1;
}

/**
 * Valida que un monto sea positivo y no absurdo (< 100M USD)
 */
export function isValidAmount(amount, { min = 0, max = 100_000_000 } = {}) {
  const n = Number(amount);
  if (isNaN(n)) return false;
  return n >= min && n <= max;
}

/**
 * Valida VIN (17 caracteres, sin I/O/Q)
 */
export function isValidVIN(vin) {
  if (!vin) return false;
  const clean = String(vin).toUpperCase().replace(/\s/g, '');
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(clean);
}

/**
 * Calcula los errores de un formulario con los validators.
 * Devuelve objeto { campo: "mensaje" } o {} si todo OK.
 *
 * Uso:
 *   const errors = validate(data, {
 *     full_name: { required: true },
 *     dni_cuit: { required: true, custom: isValidCUIT, msg: 'CUIT inválido' },
 *   });
 */
export function validate(data, schema) {
  const errors = {};
  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];

    if (rules.required && (value === null || value === undefined || value === '')) {
      errors[field] = rules.requiredMsg || 'Requerido';
      continue;
    }
    if (!value && !rules.required) continue;

    if (rules.minLength && String(value).length < rules.minLength) {
      errors[field] = `Mínimo ${rules.minLength} caracteres`;
      continue;
    }
    if (rules.maxLength && String(value).length > rules.maxLength) {
      errors[field] = `Máximo ${rules.maxLength} caracteres`;
      continue;
    }
    if (rules.email && !isValidEmail(value)) {
      errors[field] = rules.msg || 'Email inválido';
      continue;
    }
    if (rules.phone && !isValidPhone(value)) {
      errors[field] = rules.msg || 'Teléfono inválido';
      continue;
    }
    if (rules.plate && !isValidPlate(value)) {
      errors[field] = rules.msg || 'Patente inválida';
      continue;
    }
    if (rules.cuit && !isValidCUIT(value)) {
      errors[field] = rules.msg || 'CUIT inválido';
      continue;
    }
    if (rules.dni && !isValidDNI(value)) {
      errors[field] = rules.msg || 'DNI inválido';
      continue;
    }
    if (rules.custom && !rules.custom(value)) {
      errors[field] = rules.msg || 'Inválido';
      continue;
    }
  }
  return errors;
}
