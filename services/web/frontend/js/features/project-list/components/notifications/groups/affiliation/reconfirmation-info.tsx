import Notification from '../../notification'
import ReconfirmAffiliation from './reconfirm-affiliation'
import getMeta from '../../../../../../utils/meta'
import ReconfirmationInfoSuccess from '../../../../../settings/components/emails/reconfirmation-info/reconfirmation-info-success'

function ReconfirmationInfo() {
  const allInReconfirmNotificationPeriods =
    getMeta('ol-allInReconfirmNotificationPeriods') || []
  const userEmails = getMeta('ol-userEmails') || []
  const reconfirmedViaSAML = getMeta('ol-reconfirmedViaSAML')
  return (
    <>
      {allInReconfirmNotificationPeriods.map(userEmail =>
        userEmail.affiliation?.institution ? (
          <Notification
            key={`reconfirmation-period-email-${userEmail.email}`}
            bsStyle="info"
            body={
              <div className="reconfirm-notification">
                <ReconfirmAffiliation
                  email={userEmail.email}
                  institution={userEmail.affiliation.institution}
                />
              </div>
            }
          />
        ) : null
      )}
      {userEmails.map(userEmail =>
        userEmail.samlProviderId === reconfirmedViaSAML &&
        userEmail.affiliation?.institution ? (
          <Notification
            key={`samlIdentifier-email-${userEmail.email}`}
            bsStyle="info"
            onDismiss={() => {}}
            body={
              <ReconfirmationInfoSuccess
                institution={userEmail.affiliation?.institution}
              />
            }
          />
        ) : null
      )}
    </>
  )
}

export default ReconfirmationInfo
