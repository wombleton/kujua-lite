Transition = require('./transition')
_ = require('underscore')
i18n = require('../i18n')
utils = require('../lib/utils')
date = require('../date')
config = require('../config')

module.exports = new Transition(
  code: 'ohw_anc_report'
  form: 'OANC'
  required_fields: 'related_entities.clinic'
  onMatch: (change) ->
    { doc } = change
    { from, patient_id, tasks } = doc
    clinic_phone = utils.getClinicPhone(doc)
    clinic_name = utils.getClinicName(doc)
    utils.getOHWRegistration(patient_id, (err, registration) =>
      if err
        @complete(err, null)
      else
        if registration
          utils.addMessage(doc, clinic_phone, i18n("Thank you, %1$s. ANC counseling visit has been recorded.", clinic_name))
          before = date.getDate()
          before.setDate(before.getDate() + config.get('obsolete_anc_reminders_days'))
          obsoleteMessages = utils.obsoleteScheduledMessages(registration, 'anc_visit', before: before.getTime())
          @db.saveDoc(registration) if obsoleteMessages
        else
          clinic_phone = utils.getClinicPhone(doc)
          if clinic_phone
            utils.addMessage(doc, clinic_phone, i18n("No patient with id '%1$s' found.", patient_id))

        # save messages on the report so it doesn't trip this change again
        @complete(null, doc)
    )
)
