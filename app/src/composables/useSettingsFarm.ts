import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

export type FarmProfile = {
  id: string
  name: string
  location: string
  latitude: string | null
  longitude: string | null
  timezone: string | null
}

/** Farm name/location form for Settings (owner-only). */
export function useSettingsFarm(isOwner: () => boolean) {
  const { t } = useI18n()

  const farmProfile = ref<FarmProfile | null>(null)
  const farmName = ref('')
  const farmLocation = ref('')
  const farmLatitude = ref('')
  const farmLongitude = ref('')
  const farmTimezone = ref('Africa/Lagos')
  const savingFarm = ref(false)
  const farmMessage = ref<string | null>(null)

  async function loadFarm() {
    if (!isOwner()) return
    try {
      const farmData = await api<{ farm: FarmProfile }>('/api/farm')
      farmProfile.value = farmData.farm
      farmName.value = farmData.farm.name
      farmLocation.value = farmData.farm.location
      farmLatitude.value = farmData.farm.latitude ?? ''
      farmLongitude.value = farmData.farm.longitude ?? ''
      farmTimezone.value = farmData.farm.timezone ?? 'Africa/Lagos'
    } catch {
      farmProfile.value = null
    }
  }

  async function saveFarmLocation() {
    if (!isOwner()) return
    savingFarm.value = true
    farmMessage.value = null
    try {
      const data = await api<{ farm: FarmProfile }>('/api/farm', {
        method: 'PATCH',
        body: JSON.stringify({
          name: farmName.value.trim(),
          location: farmLocation.value.trim(),
          latitude: farmLatitude.value.trim() || null,
          longitude: farmLongitude.value.trim() || null,
          timezone: farmTimezone.value.trim() || 'Africa/Lagos',
        }),
      })
      farmProfile.value = data.farm
      farmMessage.value = t('settings.farmSaved')
    } catch (e) {
      farmMessage.value = e instanceof Error ? e.message : t('settings.farmSaveFailed')
    } finally {
      savingFarm.value = false
    }
  }

  return {
    farmProfile,
    farmName,
    farmLocation,
    farmLatitude,
    farmLongitude,
    farmTimezone,
    savingFarm,
    farmMessage,
    loadFarm,
    saveFarmLocation,
  }
}
