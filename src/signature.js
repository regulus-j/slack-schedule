import { readFileSync } from 'node:fs'
import path from 'node:path'

const LOGO_PATH = path.join(process.cwd(), 'assets', 'OPG - Square logo (1.5x1.5).png')
const LOGO_CID = 'opg-logo'

let cachedLogoBase64 = null

function loadLogoBase64() {
  if (cachedLogoBase64 !== null) return cachedLogoBase64
  try {
    const buffer = readFileSync(LOGO_PATH)
    cachedLogoBase64 = buffer.toString('base64')
  } catch {
    cachedLogoBase64 = ''
  }
  return cachedLogoBase64
}

export function logoAttachment(cid = LOGO_CID) {
  const base64 = loadLogoBase64()
  if (!base64) return null
  return {
    cid: `<${cid}>`,
    mimePart: [
      `Content-Type: image/png; name="opg-logo.png"`,
      'Content-Disposition: inline; filename="opg-logo.png"',
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${cid}>`,
      '',
      base64.match(/.{1,76}/g).join('\n'),
    ].join('\r\n'),
  }
}

export function generateSignatureHTML() {
  const logoCid = `cid:${LOGO_CID}`

  return [
    '<br>',
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#222222;font-size:small;">',
    '<span>--</span><br><br>',
    '<span>Best Regards,</span><br><br>',
    '</div>',
    '<div style="font-family:Arial,Helvetica,sans-serif;">',
    '<table style="font-size:medium;font-family:Arial;" width="600">',
    '<tbody>',
    '<tr>',
    '<td>',
    '<table>',
    '<tbody>',
    '<tr>',
    `<td style="vertical-align:middle;width:150px;"><span style="display:block;margin-right:20px;"><img alt="Outsourced Pro Global" src="${logoCid}" style="width:200px;height:200px;"></span></td>`,
    '<td style="vertical-align:middle;">',
    '<h2><span style="font-size:18px;color:#000000;">Outsourced Pro Global Limited</span></h2>',
    '<div><span style="font-size:14px;color:#000000;line-height:22px;">Recruitment Team</span></div>',
    '<div>&nbsp;</div>',
    '<a href="https://www.linkedin.com/company/outsourced-pro-global/" style="color:#1155cc;text-align:right;display:inline-block;padding:0px;background-color:#01585f;border-radius:50%;" target="_blank"><img alt="linkedin" src="https://cdn2.hubspot.net/hubfs/53/tools/email-signature-generator/icons/linkedin-icon-dark-2x.png" style="max-width:135px;display:block;border-radius:inherit;width:24px;"></a>',
    '<a href="https://www.facebook.com/OPGteam/" style="color:#1155cc;text-align:right;display:inline-block;padding:0px;background-color:#01585f;border-radius:50%;" target="_blank"><img alt="facebook" src="https://cdn2.hubspot.net/hubfs/53/tools/email-signature-generator/icons/facebook-icon-dark-2x.png" style="max-width:135px;display:block;border-radius:inherit;width:24px;"></a>',
    '<a href="https://www.instagram.com/_opgteam/" style="color:#1155cc;text-align:right;display:inline-block;padding:0px;background-color:#01585f;border-radius:50%;" target="_blank"><img alt="instagram" src="https://cdn2.hubspot.net/hubfs/53/tools/email-signature-generator/icons/instagram-icon-dark-2x.png" style="max-width:135px;display:block;border-radius:inherit;width:24px;"></a>',
    '</td>',
    '<td style="width:30px;"><div style="width:30px;">&nbsp;</div></td>',
    '<td style="border-bottom:none;border-left:1px solid #c8651b;height:auto;width:1px;">&nbsp;</td>',
    '<td style="width:30px;"><div style="width:30px;">&nbsp;</div></td>',
    '<td style="vertical-align:middle;">',
    '<table>',
    '<tbody>',
    '<tr>',
    '<td style="vertical-align:middle;width:30px;"><table style="width:30px;"><tbody><tr><td style="vertical-align:bottom;"><span style="display:inline-block;background-color:#c8651b;"><img alt="emailAddress" src="https://cdn2.hubspot.net/hubfs/53/tools/email-signature-generator/icons/email-icon-dark-2x.png" style="display:block;width:13px;"></span></td></tr></tbody></table></td>',
    '<td style="padding:0px;"><span style="color:#000000;"><a href="mailto:recruitment@opglobal.com.hk" style="color:#000000;font-size:14px;">recruitment@opglobal.com.hk</a></span></td>',
    '</tr>',
    '<tr>',
    '<td style="vertical-align:middle;width:30px;"><table style="width:30px;"><tbody><tr><td style="vertical-align:bottom;"><span style="display:inline-block;background-color:#c8651b;"><img alt="website" src="https://cdn2.hubspot.net/hubfs/53/tools/email-signature-generator/icons/link-icon-dark-2x.png" style="display:block;width:13px;"></span></td></tr></tbody></table></td>',
    '<td style="padding:0px;"><span style="color:#000000;"><a href="https://outsourcedproglobal.applytojob.com/apply" style="color:#1155cc;"><font size="2">OPG Careers Page</font></a></span></td>',
    '</tr>',
    '<tr>',
    '<td style="vertical-align:middle;width:30px;"><table style="width:30px;"><tbody><tr><td style="vertical-align:bottom;"><span style="display:inline-block;background-color:#c8651b;"><img alt="address" src="https://cdn2.hubspot.net/hubfs/53/tools/email-signature-generator/icons/address-icon-dark-2x.png" style="display:block;width:13px;"></span></td></tr></tbody></table></td>',
    '<td style="padding:0px;"><span style="color:#000000;font-size:14px;">135 Bonham Strand Trade Centre, Sheung Wan, Hong Kong</span></td>',
    '</tr>',
    '</tbody>',
    '</table>',
    '</td>',
    '</tr>',
    '</tbody>',
    '</table>',
    '</td>',
    '</tr>',
    '<tr>',
    '<td>',
    '<table style="width:717px;">',
    '<tbody>',
    '<tr><td style="height:30px;">&nbsp;</td></tr>',
    '<tr><td style="border-bottom:1px solid #c8651b;border-left:none;height:1px;">&nbsp;</td></tr>',
    '<tr><td style="height:30px;">&nbsp;</td></tr>',
    '</tbody>',
    '</table>',
    '</td>',
    '</tr>',
    '<tr>',
    '<td colspan="3" style="max-width:300px;padding-top:1rem;text-align:center;">',
    '<div>',
    '<p style="text-align:left;"><font size="1">IMPORTANT: The contents of this email and any attachments are confidential. They are intended for the named recipient(s) only. If you have received this email by mistake, please notify the sender immediately and do not disclose the contents to anyone or make copies thereof.</font></p>',
    '</div>',
    '</td>',
    '</tr>',
    '</tbody>',
    '</table>',
    '</div>',
  ].join('\n')
}

export function signaturePlainText() {
  return [
    '--',
    'Best Regards,',
    '',
    'Outsourced Pro Global Limited',
    'Recruitment Team',
    'recruitment@opglobal.com.hk',
    'OPG Careers Page: https://outsourcedproglobal.applytojob.com/apply',
    '135 Bonham Strand Trade Centre, Sheung Wan, Hong Kong',
    '',
    'LinkedIn: https://www.linkedin.com/company/outsourced-pro-global/',
    'Facebook: https://www.facebook.com/OPGteam/',
    'Instagram: https://www.instagram.com/_opgteam/',
    '',
    'IMPORTANT: The contents of this email and any attachments are confidential. They are intended for the named recipient(s) only. If you have received this email by mistake, please notify the sender immediately and do not disclose the contents to anyone or make copies thereof.',
  ].join('\n')
}
