import useWaitForI18n from '../../../../shared/hooks/use-wait-for-i18n'
import SubscriptionDashboard from './subscription-dashboard'

function Root() {
  const { isReady } = useWaitForI18n()

  if (!isReady) {
    return null
  }

  return <SubscriptionDashboard />
}

export default Root
