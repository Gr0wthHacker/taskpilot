/**
 * Built-in delivery templates (T694).
 *
 * Steps are operational (collect, draft, review, submit, follow up) and are
 * derived from the venture repos named in `source_ref`. They restate what
 * those repos already describe; they add no regulatory requirements.
 *
 * Every SLA below is a DEFAULT pending Jack's confirmation: each step seeds
 * with `sla_confirmed = false` and the queue UI flags it until he confirms or
 * edits it. SOP links (T695) start empty.
 *
 * Seeding is insert-if-missing by slug, so edits Jack makes in the app are
 * never overwritten by a later boot.
 */

import type { DeliveryOwnerType } from '@/shared/delivery';

export interface BuiltinStep {
  section?: string;
  title: string;
  description: string;
  owner_role: DeliveryOwnerType;
  /** Default SLA in hours. Jack to confirm. */
  sla_hours: number;
}

export interface BuiltinTemplate {
  slug: string;
  name: string;
  description: string;
  venture: string;
  source_ref: string;
  steps: BuiltinStep[];
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    slug: 'multistate-licensing',
    name: 'Multistate licensing: state application',
    description:
      'One physician, one state, full-license path. Instantiate once per state. Where a state does not need fingerprints, FCVS or a jurisprudence exam, cancel that step.',
    venture: 'MultiStateMD',
    source_ref:
      'Gr0wthHacker/state-pathways src/data/filingPaperwork.ts (buildFilingChecklist) and src/pages/Staff.tsx (filing stages)',
    steps: [
      {
        title: 'Run intake and confirm the state and pathway',
        description:
          'Confirm the physician intake details, the target state and the filing pathway (full license, IMLC or telehealth registration). Look up the board form and portal for the state.',
        owner_role: 'contractor',
        sla_hours: 24,
      },
      {
        title: 'Collect physician documents',
        description:
          'Collect the month-and-year CV with no unexplained gaps, government photo ID (front and back), medical school diploma, postgraduate training verification and the current malpractice insurance certificate.',
        owner_role: 'offshore',
        sla_hours: 72,
      },
      {
        title: 'Start the FCVS profile where the state requires it',
        description:
          'Where the state requires FCVS, get the physician started on the FCVS Physician Information Profile and track it until FSMB forwards it to the board. Cancel this step if the state does not require FCVS.',
        owner_role: 'offshore',
        sla_hours: 48,
      },
      {
        title: 'Draft the state application',
        description:
          "Prepare the application on the board's own form and portal. If the signature page must be notarized, send it to the physician for notarization.",
        owner_role: 'contractor',
        sla_hours: 72,
      },
      {
        title: 'Request existing license verifications',
        description:
          'Request verification from every state where the physician holds or held a license (board-to-board or FCVS).',
        owner_role: 'offshore',
        sla_hours: 48,
      },
      {
        title: 'Coordinate fingerprints and background check',
        description:
          "Where the board requires fingerprints, send the physician the state's fingerprint process and track submission. Cancel this step if the state has no fingerprint requirement.",
        owner_role: 'offshore',
        sla_hours: 72,
      },
      {
        title: 'Coordinate state-specific exams and forms',
        description:
          'Track any state jurisprudence exam and extra state forms or training certificates listed for the state. Cancel this step if none apply.',
        owner_role: 'offshore',
        sla_hours: 120,
      },
      {
        title: 'Review the application packet',
        description:
          'Cross-check the full packet against every board requirement for the state before filing.',
        owner_role: 'jack',
        sla_hours: 24,
      },
      {
        title: 'Submit the packet to the board',
        description:
          'File the packet, pay the board fees and record the confirmation number.',
        owner_role: 'contractor',
        sla_hours: 24,
      },
      {
        title: 'Follow up on board review',
        description:
          'Check status with the board, answer board queries and chase outstanding items until the license is approved. Update the client on each change.',
        owner_role: 'offshore',
        sla_hours: 168,
      },
    ],
  },
  {
    slug: 'clinician-standing-onboarding',
    name: 'Clinician Standing: practice onboarding',
    description:
      'Bring a client practice onto Clinician Standing: roster in, federal sources matched, exceptions worked, obligation calendar reviewed and handed to the client.',
    venture: 'Clinician Standing',
    source_ref:
      'Gr0wthHacker/clinician-standing README.md, db/migrations/0002_core.sql (practices, clinicians) and 0005_obligations.sql (obligations, exceptions)',
    steps: [
      {
        title: 'Collect the practice roster and identifiers',
        description:
          'Collect the clinician roster (names and NPIs) and the practice identifiers: legal name, organizational NPI and CMS group PAC ID. Provider and practice data only, never patient data.',
        owner_role: 'offshore',
        sla_hours: 72,
      },
      {
        title: 'Load the roster and run the source match',
        description:
          'Load the practice and clinicians, then run the ingest against the CMS Doctors and Clinicians file, the OIG exclusion list and the CMS revalidation file.',
        owner_role: 'contractor',
        sla_hours: 24,
      },
      {
        title: 'Work identity and source exceptions',
        description:
          'Resolve IDENTITY_AMBIGUOUS and SOURCE_CONFLICT exceptions raised by the match. Record the resolution on each exception.',
        owner_role: 'offshore',
        sla_hours: 48,
      },
      {
        title: 'Request documents from clinicians',
        description:
          'For each DOCUMENT_REQUIRED exception, request the document from the clinician or the practice contact and log the request.',
        owner_role: 'offshore',
        sla_hours: 48,
      },
      {
        title: 'Complete portal checks by hand',
        description:
          'Work PORTAL_REQUIRED exceptions inside PECOS, Availity or CAQH by hand. These portals are never automated.',
        owner_role: 'contractor',
        sla_hours: 72,
      },
      {
        title: 'Review high-consequence findings',
        description:
          'Review every HIGH_CONSEQUENCE exception (exclusion hit, discipline, lapse while billing) before anything goes to the client.',
        owner_role: 'jack',
        sla_hours: 24,
      },
      {
        title: 'Draft the standing summary and obligation calendar',
        description:
          'Draft the client summary of current standing and the dated obligation calendar (renewals, revalidations, CE cycles, exclusion screens).',
        owner_role: 'contractor',
        sla_hours: 48,
      },
      {
        title: 'Review and send to the client',
        description: 'Review the summary and calendar, then send them to the practice.',
        owner_role: 'jack',
        sla_hours: 24,
      },
      {
        title: 'Follow up on open document requests',
        description:
          'Chase outstanding document requests and close the related exceptions as documents arrive. Move the practice to active monitoring when the queue is clear.',
        owner_role: 'offshore',
        sla_hours: 168,
      },
    ],
  },
  {
    slug: 'stetwright-practice-programs',
    name: 'Stetwright practice programs',
    description:
      'Setup work for the HIPAA, Section 504 and AI use programs. When instantiating, pick the sections the client bought.',
    venture: 'Stetwright',
    source_ref:
      'Gr0wthHacker/compliance-gate apps/marketing/src/content/practicePrograms.ts (setup and ongoing lists)',
    steps: [
      // HIPAA privacy and security program
      {
        section: 'hipaa',
        title: 'HIPAA: collect existing policies, notices and forms',
        description:
          'Gather what the practice already has: policies and procedures, the Notice of Privacy Practices and the forms staff use day to day.',
        owner_role: 'offshore',
        sla_hours: 72,
      },
      {
        section: 'hipaa',
        title: 'HIPAA: draft the gap list',
        description:
          'List what is missing against the HIPAA Privacy, Security and Breach Notification Rules.',
        owner_role: 'contractor',
        sla_hours: 48,
      },
      {
        section: 'hipaa',
        title: 'HIPAA: draft policies, notice and forms',
        description:
          'Draft or update the policies and procedures, the Notice of Privacy Practices and the staff forms.',
        owner_role: 'contractor',
        sla_hours: 120,
      },
      {
        section: 'hipaa',
        title: 'HIPAA: collect security risk analysis inputs',
        description:
          'Collect the inputs for the security risk analysis and open a tracker for the follow-up items it produces.',
        owner_role: 'offshore',
        sla_hours: 72,
      },
      {
        section: 'hipaa',
        title: 'HIPAA: collect the vendor and BAA list',
        description:
          'List the vendors that touch patient information and record which ones have a business associate agreement on file.',
        owner_role: 'offshore',
        sla_hours: 72,
      },
      {
        section: 'hipaa',
        title: 'HIPAA: review the program drafts',
        description: 'Review the drafted policies, notice, forms, vendor list and risk analysis tracker.',
        owner_role: 'jack',
        sla_hours: 48,
      },
      {
        section: 'hipaa',
        title: 'HIPAA: deliver and set up ongoing records',
        description:
          'Deliver the program to the practice and set up the training completion record, the privacy incident log and the yearly review date.',
        owner_role: 'contractor',
        sla_hours: 48,
      },
      // Section 504 disability access program
      {
        section: 'section-504',
        title: 'Section 504: confirm coordinator and grievance contact',
        description:
          'Get the name of the practice coordinator and the people who will handle grievances.',
        owner_role: 'offshore',
        sla_hours: 48,
      },
      {
        section: 'section-504',
        title: 'Section 504: draft notice, policies and grievance steps',
        description:
          'Draft the notice of nondiscrimination, the written grievance process and the policies for auxiliary aids, interpreters and reasonable modifications.',
        owner_role: 'contractor',
        sla_hours: 120,
      },
      {
        section: 'section-504',
        title: 'Section 504: run the website and app accessibility review',
        description:
          'Review the website and patient-facing apps for accessibility and draft the list of fixes with owners and dates.',
        owner_role: 'contractor',
        sla_hours: 120,
      },
      {
        section: 'section-504',
        title: 'Section 504: review the program drafts',
        description: 'Review the notice, policies, grievance steps and the accessibility fix list.',
        owner_role: 'jack',
        sla_hours: 48,
      },
      {
        section: 'section-504',
        title: 'Section 504: deliver and set up ongoing records',
        description:
          'Deliver the program and set up the record of requests and grievances, staff training on requests, and a recheck after each website redesign or new patient tool.',
        owner_role: 'contractor',
        sla_hours: 48,
      },
      // AI use program
      {
        section: 'ai',
        title: 'AI use: collect the AI tool inventory',
        description:
          'Collect the AI tools in use, who uses them and whether patient information goes into them.',
        owner_role: 'offshore',
        sla_hours: 72,
      },
      {
        section: 'ai',
        title: 'AI use: collect vendor terms and BAA status',
        description:
          'For each tool that receives patient information, collect the vendor terms and whether a business associate agreement is in place.',
        owner_role: 'offshore',
        sla_hours: 72,
      },
      {
        section: 'ai',
        title: 'AI use: draft the AI use policy',
        description:
          'Draft the policy covering approved tools, what may not be entered, and human review of anything sent to patients.',
        owner_role: 'contractor',
        sla_hours: 72,
      },
      {
        section: 'ai',
        title: 'AI use: flag tools that support patient care decisions',
        description:
          'Note any tools used to support patient care decisions so they get their own review under Section 1557 for covered entities.',
        owner_role: 'contractor',
        sla_hours: 48,
      },
      {
        section: 'ai',
        title: 'AI use: review the program drafts',
        description: 'Review the inventory, vendor terms summary, policy and flagged tools.',
        owner_role: 'jack',
        sla_hours: 48,
      },
      {
        section: 'ai',
        title: 'AI use: deliver and set up ongoing records',
        description:
          'Deliver the policy and set up the staff training completion record, review of new tools before use, and the yearly inventory and policy update date.',
        owner_role: 'contractor',
        sla_hours: 48,
      },
    ],
  },
];
