import { App } from '@slack/bolt'
import { loadConfig } from '../src/config.js'
import { createStore } from '../src/store/index.js'
import {
  buildFeedbackRequestEmail,
  buildReminderEmail,
} from '../src/workflow/messages.js'
import {
  deliverNotification,
  NOTIFICATION_TYPES,
} from '../src/workflow/notifications.js'
import { SYDNEY_TIME_ZONE, formatDateInTimeZone } from '../src/time.js'

const SUPPORTED_TYPES = new Set([
  ...Object.values(NOTIFICATION_TYPES),
  'all',
])

async function run() {
  const args = parseArgs(process.argv.slice(2))
  validateArgs(args)

  const config = loadConfig()
  const store = await createStore(config)
  await store.init()
  const cases = args.today
    ? (await store.listCases()).filter((item) =>
        formatDateInTimeZone(item.createdAt, config.scheduling?.timeZone || SYDNEY_TIME_ZONE) === todayInTimeZone(config.scheduling?.timeZone),
      )
    : [await store.getCase(args.caseId)]
  if (!args.today && !cases[0]) throw new Error(`Case not found: ${args.caseId}`)
  if (args.today && cases.length === 0) {
    console.log('No cases were created today.')
    return
  }

  const types = args.type === 'all'
    ? Object.values(NOTIFICATION_TYPES)
    : [args.type]
  validateRecipients(args, types)

  if (!args.deliver) {
    for (const caseRecord of cases) {
      for (const type of types) {
        console.log(JSON.stringify({ caseId: caseRecord.id, ...buildPreview(type, caseRecord, config, args) }, null, 2))
      }
    }
    return
  }

  const requiresSlack = types.some(isSlackType)
  const app = requiresSlack
    ? new App({
        token: config.slack.botToken,
        signingSecret: 'notification-test-cli',
      })
    : null

  for (const caseRecord of cases) {
    for (const type of types) {
      const result = await deliverNotification({
        type,
        job: {
          caseId: caseRecord.id,
          scheduleVersion: caseRecord.scheduleVersion || 0,
        },
        store,
        client: app?.client,
        config,
        logger: consoleLogger(),
        recipientOverrides: {
          slackUser: args.slackUser,
          email: args.email,
        },
        testMode: true,
      })
      console.log(JSON.stringify({ caseId: caseRecord.id, type, result: serializableResult(result) }, null, 2))
    }
  }
}

function todayInTimeZone(timeZone) {
  return formatDateInTimeZone(new Date(), timeZone || SYDNEY_TIME_ZONE)
}

function buildPreview(type, caseRecord, config, args) {
  if (type === NOTIFICATION_TYPES.CANDIDATE_REMINDER) {
    const email = buildReminderEmail(caseRecord)
    return {
      type,
      delivery: 'dry-run',
      to: args.email || email.to,
      subject: email.subject,
      plainBody: email.plainBody,
    }
  }
  if (type === NOTIFICATION_TYPES.FEEDBACK_REQUEST) {
    const email = buildFeedbackRequestEmail(
      caseRecord,
      config.notifications.feedbackFormUrl || '[FEEDBACK_FORM_URL]',
    )
    return {
      type,
      delivery: 'dry-run',
      to: args.email || email.to,
      subject: email.subject,
      plainBody: email.plainBody,
    }
  }
  return {
    type,
    delivery: 'dry-run',
    slackUser: args.slackUser || caseRecord.recruiter?.slackUserId || caseRecord.ownerSlackUserId,
    caseId: caseRecord.id,
    candidate: [
      caseRecord.applicant?.firstName,
      caseRecord.applicant?.lastName,
    ].filter(Boolean).join(' '),
    role: caseRecord.applicant?.jobTitle || '',
    note: type === NOTIFICATION_TYPES.JAZZHR_RECHECK
      ? 'JazzHR will be checked and a DM sent only if the stage is unchanged.'
      : 'JazzHR will be checked before the completion DM is sent.',
  }
}

function parseArgs(argv) {
  const args = {
    caseId: '',
    today: false,
    type: '',
    deliver: false,
    slackUser: '',
    email: '',
    useCaseRecipients: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--case') args.caseId = argv[++index] || ''
    else if (value === '--today') args.today = true
    else if (value === '--type') args.type = argv[++index] || ''
    else if (value === '--slack-user') args.slackUser = argv[++index] || ''
    else if (value === '--email') args.email = argv[++index] || ''
    else if (value === '--deliver') args.deliver = true
    else if (value === '--use-case-recipients') args.useCaseRecipients = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  return args
}

function validateArgs(args) {
  if (!args.caseId && !args.today) throw new Error('--case <id> or --today is required')
  if (args.caseId && args.today) throw new Error('--case and --today cannot be used together')
  if (!SUPPORTED_TYPES.has(args.type)) {
    throw new Error(`--type must be one of: ${[...SUPPORTED_TYPES].join(', ')}`)
  }
}

function validateRecipients(args, types) {
  if (args.useCaseRecipients) return
  if (types.some(isEmailType) && !args.email) {
    throw new Error('--email is required for email notifications unless --use-case-recipients is supplied')
  }
  if (types.some(isSlackType) && !args.slackUser) {
    throw new Error('--slack-user is required for Slack notifications unless --use-case-recipients is supplied')
  }
}

function isEmailType(type) {
  return [
    NOTIFICATION_TYPES.CANDIDATE_REMINDER,
    NOTIFICATION_TYPES.FEEDBACK_REQUEST,
  ].includes(type)
}

function isSlackType(type) {
  return [
    NOTIFICATION_TYPES.COMPLETION_REMINDER,
    NOTIFICATION_TYPES.JAZZHR_RECHECK,
  ].includes(type)
}

function serializableResult(result) {
  return JSON.parse(JSON.stringify(result, (key, value) => {
    if (key === 'htmlBody' || key === 'body') return undefined
    if (key === 'attachments') return value?.map((item) => ({
      filename: item.filename,
      mimeType: item.mimeType,
      bytes: item.content?.length || 0,
    }))
    return value
  }))
}

function consoleLogger() {
  return {
    info(event, details) {
      console.error(event, details || '')
    },
    warn(event, details) {
      console.error(event, details || '')
    },
    error(event, details) {
      console.error(event, details || '')
    },
  }
}

if (!process.env.NODE_TEST_CONTEXT) {
  run().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
