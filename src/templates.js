import { promises as fs } from 'node:fs';
import path from 'node:path';
import { generateSignatureHTML, signaturePlainText } from './signature.js';

const TEMPLATE_DIR = path.join(process.cwd(), 'email-templates');
export const SCHEDULING_TEMPLATE_IDS = ['1st-interview-invite', '2nd-or-Final-invite'];

export const TEMPLATE_LABELS = {
  '1st-interview-invite': '1st interview invite',
  '2nd-or-Final-invite': '2nd/final interview invite',
  'interview-reminder': 'Interview reminder',
  'interview-reminder (unresponsive candidate)': 'Unresponsive candidate reminder',
  'Thank You Email - 2nd-or-Final Interview': 'Thank-you email',
};

export const TEMPLATE_METADATA = {
  '1st-interview-invite': {
    interviewStage: '1st Interview',
    resumeRequired: false,
  },
  '2nd-or-Final-invite': {
    interviewStage: '2nd/Final Interview',
    resumeRequired: true,
  },
  'interview-reminder': {
    interviewStage: 'Reminder',
    resumeRequired: false,
  },
  'interview-reminder (unresponsive candidate)': {
    interviewStage: 'Reminder',
    resumeRequired: false,
  },
  'Thank You Email - 2nd-or-Final Interview': {
    interviewStage: 'Thank You',
    resumeRequired: false,
  },
};

const MOJIBAKE_FIXES = [
  [/â€™/g, "'"],
  [/â€œ|â€�/g, '"'],
  [/â€“|â€”/g, '-'],
  [/Â /g, ' '],
  [/Â/g, ''],
  [/ðŸ“…/g, 'Date:'],
  [/â°/g, 'Time:'],
  [/ðŸ’»/g, 'Platform:'],
  [/ðŸ”—/g, 'Meeting Link:'],
  [/ðŸ“ž/g, 'phone'],
];

export function normalizeTemplateText(text) {
  let normalized = String(text || '').replace(/\r\n/g, '\n');
  for (const [pattern, replacement] of MOJIBAKE_FIXES) {
    normalized = normalized.replace(pattern, replacement);
  }
  normalized = normalized.replace(/^Subeject:/im, 'Subject:');
  return normalized.trim();
}

export function parseTemplate(filename, rawText) {
  const text = normalizeTemplateText(rawText);
  const subjectMatch = text.match(/^Subject:\s*(.+)$/im);
  const bodyMatch = text.match(/^Body:\s*\n?([\s\S]*)$/im);

  return {
    id: filename,
    label: TEMPLATE_LABELS[filename] || filename,
    ...TEMPLATE_METADATA[filename],
    subject: subjectMatch ? subjectMatch[1].trim() : '',
    body: bodyMatch ? bodyMatch[1].trim() : text,
  };
}

export async function loadTemplates(templateDir = TEMPLATE_DIR) {
  const entries = await fs.readdir(templateDir);
  const templates = [];

  for (const filename of entries) {
    const filePath = path.join(templateDir, filename);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) continue;
    const rawText = await fs.readFile(filePath, 'utf8');
    templates.push(parseTemplate(filename, rawText));
  }

  return templates.sort((a, b) => a.label.localeCompare(b.label));
}

export async function loadSchedulingTemplates(templateDir = TEMPLATE_DIR) {
  const templates = await loadTemplates(templateDir)
  return templates.filter((template) => isSchedulingTemplate(template.id))
}

export function isSchedulingTemplate(templateId) {
  return SCHEDULING_TEMPLATE_IDS.includes(templateId)
}

export function renderTemplate(template, variables) {
  const htmlBody = replaceVariables(template.body, variables)
  const plainBody = replaceVariables(stripHtmlBody(template.body), { ...variables, _signature: signaturePlainText() })
  return {
    ...template,
    subject: replaceVariables(template.subject, variables),
    body: htmlBody,
    plainBody,
  };
}

export function replaceVariables(text, variables) {
  const resolved = variables['_signature'] || generateSignatureHTML()
  const plainSig = variables['_signature_plain'] || signaturePlainText()

  return String(text || '').replace(/\[([^\]]+)\]/g, (match, key) => {
    const trimmed = key.trim()
    if (trimmed.toLowerCase() === 'signature') return resolved
    const normalizedKey = trimmed.toLowerCase().replace(/\s+/g, '_')
    const value = variables[normalizedKey] ?? variables[trimmed] ?? ''
    return value || match
  })
}

export function stripHtmlBody(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function plainTextToHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(/\r?\n/g, '<br>')
}

export function signedEmailBodiesFromPlainText(text) {
  const plainBody = ensureSignaturePlainText(text)
  return {
    plainBody,
    htmlBody: signedPlainTextToHtml(plainBody),
  }
}

export function ensureSignaturePlainText(text) {
  const body = String(text || '').trim()
  const signature = signaturePlainText()
  if (hasPlainSignature(body)) return body
  return [body, signature].filter(Boolean).join('\n\n')
}

function signedPlainTextToHtml(text) {
  const body = String(text || '').trim()
  const signature = signaturePlainText()
  if (body.endsWith(signature)) {
    const content = body.slice(0, -signature.length).trim()
    return [plainTextToHtml(content), generateSignatureHTML()].filter(Boolean).join('\n')
  }
  return plainTextToHtml(body)
}

function hasPlainSignature(text) {
  const value = String(text || '')
  return value.includes('Outsourced Pro Global Limited') && value.includes('IMPORTANT: The contents of this email')
}

export function templateOptions(templates) {
  return templates.map((template) => ({
    text: {
      type: 'plain_text',
      text: template.label.slice(0, 75),
    },
    value: template.id,
  }));
}

export function templateRequiresResume(templateId) {
  return Boolean(TEMPLATE_METADATA[templateId]?.resumeRequired);
}
