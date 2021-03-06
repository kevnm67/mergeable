const getValidatorPromises = require('./getValidatorPromises')
const getActionPromises = require('./getActionPromises')
const consolidateResult = require('../../validators/options_processor/options/lib/consolidateResults')
const constructErrorOutput = require('../../validators/options_processor/options/lib/constructErrorOutput')
const Register = require('../../register')
const extractValidationStats = require('../../stats/extractValidationStats')
const Checks = require('../../actions/checks')
const Comment = require('../../actions/comment')
const _ = require('lodash')

const logger = require('../../logger')

const processWorkflow = async (context, registry, config) => {
  let log = logger.create('flex')
  // go through the settings and register all the validators
  try {
    Register.registerValidatorsAndActions(config.settings, registry)
  } catch (err) {
    let evt = `${context.event}.${context.payload.action}`
    let checks = new Checks()
    if (checks.isEventSupported(evt)) {
      checks.run({
        context: context,
        payload: {
          status: 'completed',
          conclusion: 'cancelled',
          output: {
            title: 'Invalid Validators or Actions',
            summary: `${err}`
          },
          completed_at: new Date()
        }
      })
    }
  }

  // do pre validation actions
  await processPreActions(context, registry, config)

  for (const rule of config.settings) {
    if (isEventInContext(rule.when, context)) {
      const result = await Promise.all(getValidatorPromises(context, registry, rule)).catch((err) => {
        const unknownErrorLog = {
          log_type: logger.logTypes.UNKNOWN_ERROR_VALIDATOR,
          errors: err.toString(),
          repo: context.payload.repository.full_name,
          event: `${context.event}.${context.payload.action}`,
          settings: JSON.stringify(config.settings)
        }
        log.error(unknownErrorLog)

        return Promise.resolve([consolidateResult(
          [
            constructErrorOutput(
              'An error occured',
              '',
              {},
              'Internal error!',
              'This is a mergeable bug, please report it on our issue tracker: https://github.com/mergeability/mergeable/issues/new\n\n' +
              '```\n' + (err.stack ? err.stack : err.toString()) + '\n```\n\n'
            )
          ],
          {name: 'Internal error'}
        )])
      })

      const translatedOutput = extractValidationStats(result)
      const promises = getActionPromises(context, registry, rule, translatedOutput)
      if (promises) {
        let errorOccurred = false

        const event = `${context.event}.${context.payload.action}`
        const comment = new Comment()

        await Promise.all(promises).catch((err) => {
          errorOccurred = true
          const payload = {
            body: '####  :x: Error Occurred while executing an Action \n\n ' +
              'If you believe this is an unexpected error, please report it on our issue tracker: https://github.com/mergeability/mergeable/issues/new \n' +
              '##### Error Details \n' +
              '-------------------- \n' +
              `${err.toString()}`
          }

          const unknownErrorLog = {
            log_type: logger.logTypes.UNKNOWN_ERROR_ACTION,
            errors: err.toString(),
            repo: context.payload.repository.full_name,
            event: `${context.event}.${context.payload.action}`,
            settings: JSON.stringify(config.settings)
          }
          log.error(unknownErrorLog)
          if (comment.isEventSupported(event)) {
            comment.handleError(context, payload)
          }
        })

        if (!errorOccurred && comment.isEventSupported(event)) await comment.removeErrorComments(context)
      }
    }
  }
}

// call all action classes' beforeValidate, regardless of whether they are in failure or pass situation
const processPreActions = async (context, registry, config) => {
  let promises = []

  config.settings.forEach(rule => {
    if (isEventInContext(rule.when, context)) {
      // get actions within this rule
      const actions = extractAllActionFromRecipe(rule)
      // for each action, do the following
      actions.forEach(action => {
        if (registry.actions.get(action).isEventSupported(`${context.event}.${context.payload.action}`)) {
          promises.push(registry.actions.get(action).processBeforeValidate(context, rule, rule.name))
        }
      })
    }
  })

  await Promise.all(promises)
}

const extractAllActionFromRecipe = (recipe) => {
  let passActions = recipe.pass ? recipe.pass.map(action => action.do) : []
  let failActions = recipe.fail ? recipe.fail.map(action => action.do) : []
  let errorActions = recipe.error ? recipe.error.map(action => action.do) : []

  let action = _.union(passActions, failActions)
  action = _.union(action, errorActions)

  return action
}

const isEventInContext = (event, context) => {
  let eventArray = event.split(', ')
  let contextEvent = `${context.event}.${context.payload.action}`
  let found = eventArray.find(element => {
    if (element.split('.')[1] === '*') {
      return element.split('.')[0] === context.event
    } else {
      return element === contextEvent
    }
  })

  return !!found
}

module.exports = processWorkflow
