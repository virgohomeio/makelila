// The UPS pesticide worksheet, per shipment.
//
// UPS Supply Chain Solutions asks for a FIFRA worksheet on every entry it
// brokers, and will not act as importer of record without one. Every LILA we
// send through UPS needs the same answer — the machine is a kitchen appliance,
// not a pesticide device — so the form was being filled in by hand, one PDF
// per tracking number, and then attached to the EZ Trans booking manually.
// This builds it instead, from the same queue row the packing list is built
// from, and the send-eztrans-booking function attaches it whenever the carrier
// on the row is UPS.
//
// Deliberately NOT an operator-editable template, unlike the booking email and
// the packing list. It is a declaration to CBP carrying a real signature, and
// the sentence that matters — that the product is outside the FIFRA
// definitions — is a legal position, not copy. Changing it should be a commit
// with a reviewer, not a text box.
//
// What varies per shipment is only ever: the tracking number, the serial /
// batch / quantity / order reference in the description of goods, and the
// date. The part number and the tariff classification are properties of the
// product, identical on every LILA Pro we have ever filed (verified against
// the worksheets filed by hand for 1Z...93221574, ...98518192 and
// ...98125759), so they are constants here rather than per-shipment inputs.

import type { PdfLine } from './simplePdf.ts';
import type { PdfImage } from './pngToPdfImage.ts';

/** Harmonized tariff classification for the LILA Pro: electro-mechanical
 *  domestic appliance with a self-contained electric motor, other. Constant
 *  across every unit we ship — see the module comment. */
export const PESTICIDE_TARIFF_NUMBER = '8509.80.5095';

/** As it appears on the worksheet's Part Number line. */
export const PESTICIDE_PART_NUMBER = 'LILA-P100X (LILA Pro)';

/** The fixed half of the description of goods; the shipment's own identifiers
 *  are appended to it. */
export const PESTICIDE_GOODS_DESCRIPTION =
  'LILA Kitchen Composter — household countertop electromechanical food waste ' +
  'composter (grinding, heating and drying appliance with self-contained electric motor).';

/** Who signs. The signature image itself is not in this repo — it is a real
 *  person's handwritten signature and the repo is public — so it is read from
 *  a private storage bucket at send time. */
export const PESTICIDE_CERTIFIER = {
  name: 'Huayi Gao',
  email: 'huayi@virgohome.io',
  company: 'VCycene Inc.',
  title: 'Co-founder & CTO',
  address: '3600 Steeles Ave. E., Markham, ON L3R 9Z7, CA',
  phone: '+1 416-768-9336',
} as const;

/** Storage object holding the certifier's signature, as a PNG. Private bucket:
 *  the edge function reads it with the service role. */
export const SIGNATURE_BUCKET = 'company-assets';
export const SIGNATURE_PATH = 'signatures/huayi-gao.png';

export type PesticideWorksheetArgs = {
  /** The carrier tracking number — the worksheet's "shipment number". */
  trackingNumber: string;
  serial: string;
  batchLot: string;
  quantity: number;
  orderRef: string;
  /** The day the label was attached and this worksheet went out, as
   *  `formatWorksheetDate` renders it. */
  date: string;
  /** The certifier's signature. Omitted only if the asset could not be read —
   *  the form is still built, with the line left blank and said so. */
  signature?: PdfImage | null;
};

/** "September 23, 2026" — the long form the filed worksheets use. */
export function formatWorksheetDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

/** What goes on the Description of Goods line, shipment identifiers and all. */
export function goodsDescription(a: Pick<PesticideWorksheetArgs,
  'serial' | 'batchLot' | 'quantity' | 'orderRef'>): string {
  return `${PESTICIDE_GOODS_DESCRIPTION} Serial No. ${a.serial} · Batch/Lot ${a.batchLot} · ` +
    `Qty ${a.quantity} · Order ref ${a.orderRef}`;
}

const BODY = 7.6;
/** Paragraph leading. The filed worksheets set their body copy tight; at the
 *  writer's list default of 1.5 the same words run to a third page. */
const LEAD = 1.18;
const LABEL_X = 16;
const VALUE_X = 120;
/** Where the certification block's right-hand column starts, and therefore how
 *  wide a left-hand value may be before it has to wrap. */
const RIGHT_LABEL_X = 330;
const RIGHT_VALUE_X = 386;
const RIGHT_RULE = 114;
const LEFT_RULE = 190;

/** Label / value row in the product-information and certification blocks. */
function field(label: string, value: string, opts?: {
  rule?: number; valueX?: number; labelX?: number; gap?: number; maxWidth?: number; size?: number;
}): PdfLine[] {
  const size = opts?.size ?? 8.5;
  return [
    { text: label, size, bold: true, indent: opts?.labelX ?? LABEL_X },
    {
      text: value, size, bold: true, sameLine: true,
      indent: opts?.valueX ?? VALUE_X,
      rule: opts?.rule,
      maxWidth: opts?.maxWidth,
      lead: 1.35,
      gap: opts?.gap ?? 8,
    },
  ];
}

/** One row of the certification block: a label/value pair on the left and
 *  another on the right, sharing a baseline. The left value is wrapped to stop
 *  short of the right label — the address is long enough to run into it. */
function certRow(
  leftLabel: string, leftValue: string, rightLabel: string, rightValue: string, size = 8.5,
): PdfLine[] {
  // The left value goes last because it is the only one that may wrap: every
  // `sameLine` entry hangs off the baseline of the one before it, so anything
  // that moves the baseline down has to come after the fields sharing it.
  return [
    { text: leftLabel, size, bold: true, indent: LABEL_X },
    { text: rightLabel, size, bold: true, sameLine: true, indent: RIGHT_LABEL_X },
    {
      text: rightValue, size, bold: true, sameLine: true, indent: RIGHT_VALUE_X,
      rule: RIGHT_RULE,
    },
    {
      text: leftValue, size, bold: true, sameLine: true, indent: VALUE_X,
      rule: LEFT_RULE, maxWidth: RIGHT_LABEL_X - VALUE_X - 10, lead: 1.35, gap: 10,
    },
  ];
}

/** The worksheet, as lines for buildTextPdf. */
export function pesticideWorksheetLines(a: PesticideWorksheetArgs): PdfLine[] {
  const lines: PdfLine[] = [
    { text: 'UPS Supply Chain Solutions, Inc.', size: 13, bold: true, center: true, gap: 2 },
    { text: 'Pesticide and Pesticide Device Products Worksheet', size: 11, bold: true, center: true, gap: 12 },

    { text: `Date: ${a.date}`, size: 8.5, bold: true, gap: 8 },

    { text: '[ ] This is a blanket statement for the time period  N/A  to  N/A', size: BODY, lead: LEAD, gap: 6 },
    {
      text: `[X] This is a single entry worksheet for shipment number: ${a.trackingNumber}`,
      size: BODY, lead: LEAD, bold: true, gap: 8,
    },

    {
      text: 'Note: Blanket may apply up to 12 months on shipments with the same commodity.',
      size: BODY, lead: LEAD, gap: 4,
    },
    {
      text: 'Note: UPS will not act as IOR on entries that prompt for EPA-regulated pesticide, ' +
        'and pesticide device entries, including when using disclaim A.',
      size: BODY, lead: LEAD, gap: 8,
    },
    {
      text: 'This shipment may contain a pesticide or pesticide device. Such products are ' +
        'regulated by the EPA under the Federal Insecticide, Fungicide and Rodenticide Act (FIFRA).',
      size: BODY, lead: LEAD, gap: 8,
    },
    {
      text: 'Per FIFRA, the terms pest, pesticide, and pesticide device are defined as:',
      size: BODY, lead: LEAD, gap: 8,
    },

    {
      text: 'Pest – The term "pest" means (1) any insect, rodent, nematode, fungus, weed, or ' +
        '(2) any other form of terrestrial or aquatic plant or animal life or virus, bacteria, ' +
        'or other micro-organism (except viruses, bacteria, or other micro-organisms on or in ' +
        'living man or other living animals) which the EPA declares to be a pest under FIFRA ' +
        'Section 25(c)(1).',
      size: BODY, lead: LEAD, gap: 6,
    },
    {
      text: 'Pesticide – The term "pesticide" means (1) any substance or mixture of substances ' +
        'intended for preventing, destroying, repelling, or mitigating any pest, (2) any ' +
        'substance or mixture of substances intended for use as plant regulator, defoliant, or ' +
        'desiccant, and (3) any nitrogen stabilizer, except that the term "pesticide" shall not ' +
        'include any article that is a "new animal drug" within the meaning of section 201(w) of ' +
        'the Federal Food, Drug, and Cosmetic Act (21 U.S.C. 321(w)), that has been determined by ' +
        'the Secretary of Health and Human Services not to be a new animal drug by a regulation ' +
        'establishing conditions of use for the article, or that is an animal feed within the ' +
        'meaning of section 201(x) of such Act (21 U.S.C. 321(x)) bearing or containing a new ' +
        'animal drug. The term "pesticide" does not include liquid chemical sterilant products ' +
        '(including any sterilant or subordinate disinfectant claims on such products) for use on ' +
        'a critical or semi-critical device, as defined in section 201 of the Federal Food Drug, ' +
        'and Cosmetic Act (21 U.S.C. 321).',
      size: BODY, lead: LEAD, gap: 6,
    },
    {
      text: 'Pesticide Device – A pesticide "device" means any instrument or contrivance (other ' +
        'than a firearm) which is intended for trapping, destroying, repelling, or mitigating any ' +
        'pest or any other form of plant or animal life (other than man and other bacteria, virus, ' +
        'or other micro-organism on or in living man or other living animals); but not including ' +
        'equipment used for the application of pesticides when sold separately therefrom.',
      size: BODY, lead: LEAD, gap: 10,
    },

    { text: 'PRODUCT INFORMATION', size: 9, bold: true, gap: 10 },
    ...field('Part Number:', PESTICIDE_PART_NUMBER, { rule: 330 }),
    ...field('Description of Goods:', goodsDescription(a), { rule: 330 }),
    ...field('Tariff Number:', PESTICIDE_TARIFF_NUMBER, { rule: 330, gap: 16 }),

    { text: 'Is the above product(s) a pesticide or pesticide device?', size: 9, bold: true, gap: 8 },
    {
      text: '[ ] Yes. Based on the definitions of pesticide and pesticide device(s) and the ' +
        'guidance provided by the EPA in the links above, this product is regulated by EPA ' +
        '(Importer must complete and return the Notice of Arrival of Pesticides and Devices form ' +
        '3540-1 for shipment to be processed. Importer must provide Pesticide/Devices label and ' +
        'instructions of use to be submitted to EPA at time of clearance.)',
      size: BODY, lead: LEAD, gap: 6,
    },
    {
      text: '[X] No. Based on the definitions of pesticide and pesticide device(s) and the ' +
        'guidance provided by the EPA in the links above, this product is not regulated by EPA. ' +
        'I understand that falsely claiming that this product is not an EPA-regulated pesticide ' +
        'or pesticide device may result in CBP penalties.',
      size: BODY, lead: LEAD, bold: true, gap: 10,
    },

    { text: "Please indicate the commodity's intended use.", size: 9, bold: true, gap: 8 },
    {
      text: 'The LILA Pro (P100X) is a household countertop food waste composter. Its sole ' +
        'intended use is to reduce the volume of post-consumer kitchen food scraps by grinding, ' +
        'heating and drying them into a dry, shelf-stable soil amendment for home use.',
      size: BODY, lead: LEAD, gap: 6,
    },
    {
      text: 'The unit contains no pesticide, biocide, antimicrobial agent or any other pesticidal ' +
        'substance, and no pesticide is applied, released or dispensed by the appliance. Odor ' +
        'management is handled by a replaceable activated-carbon filter together with a low-output ' +
        'UV/ozone lamp that treats only the appliance’s internal exhaust air stream to neutralize ' +
        'cooking and food-waste odor compounds. That lamp is enclosed within the sealed appliance ' +
        'housing, is not user-accessible, does not irradiate any room, surface, object or occupant, ' +
        'and is specified and sold solely for odor reduction.',
      size: BODY, lead: LEAD, gap: 6,
    },
    {
      text: 'The product is not designed, manufactured, sold or intended for trapping, destroying, ' +
        'repelling or mitigating insects, rodents, nematodes, fungi, weeds, bacteria, viruses or ' +
        'any other micro-organism or form of plant or animal life. VCycene Inc. makes no ' +
        'antimicrobial, germicidal, disinfecting, sanitizing, sterilizing or pest-control efficacy ' +
        'claims for this product on its packaging, labeling, user manual or product literature, ' +
        'and the product carries no such claims. Accordingly the product falls outside the FIFRA ' +
        'definitions of a pesticide and of a pesticide device.',
      size: BODY, lead: LEAD, gap: 6,
    },
    {
      text: '(Copy of product label and instructions for use are provided with this worksheet to ' +
        'substantiate this claim.)',
      size: BODY, lead: LEAD,
    },

    // The filed worksheets carry the certification on its own page; keeping it
    // there means a signature is never orphaned halfway down a definition.
    { text: 'CERTIFICATION', size: 9, bold: true, pageBreak: true, gap: 14 },
    ...certRow('Certifying Individual:', PESTICIDE_CERTIFIER.name, 'Email:', PESTICIDE_CERTIFIER.email),
    ...certRow('Company:', PESTICIDE_CERTIFIER.company, 'Title:', PESTICIDE_CERTIFIER.title),
    ...certRow('Address:', PESTICIDE_CERTIFIER.address, 'Phone #:', PESTICIDE_CERTIFIER.phone, 7.6),
  ];

  if (a.signature) {
    lines.push({
      text: `[signature of ${PESTICIDE_CERTIFIER.name}]`,
      image: a.signature,
      imageWidth: 130,
      indent: VALUE_X,
      gap: 0,
    });
  } else {
    // Said out loud rather than left as an unexplained blank: a worksheet that
    // reaches the broker unsigned is one they will bounce.
    lines.push({ text: ' ', size: 20, gap: 8 });
  }

  lines.push(
    ...certRow('Signature:', ' ', 'Date:', a.date),
    {
      text: 'By signing above, you certify that the information provided is complete and accurate ' +
        'and that you have used reasonable care in ascertaining and providing such information.',
      size: 7,
    },
  );

  return lines;
}

/** Filename for the attachment, scoped to the order it belongs to. */
export function pesticideWorksheetFilename(orderRef: string): string {
  return `pesticide-worksheet-${orderRef.replace(/[^A-Za-z0-9._-]/g, '')}.pdf`;
}
