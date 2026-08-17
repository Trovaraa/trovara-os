<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import { api } from '@/lib/api'

type Permission = { key: string; category: string; description: string; nonDelegable: boolean }
type Staff = { id: string; name: string; email: string; role: string }
type Team = { id: string; name: string; description: string | null; permissions: string[]; memberIds: string[] }
type Override = { userId: string; permissionKey: string; effect: 'allow' | 'deny' }

const catalog = ref<Permission[]>([])
const users = ref<Staff[]>([])
const teams = ref<Team[]>([])
const overrides = ref<Override[]>([])
const selectedTeamId = ref('')
const selectedUserId = ref('')
const teamDraft = ref({ name: '', description: '', permissions: [] as string[], memberIds: [] as string[] })
const overrideDraft = ref<Record<string, 'inherit' | 'allow' | 'deny'>>({})
const { t } = useI18n()
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const message = ref<string | null>(null)

const delegable = computed(() => catalog.value.filter((permission) => !permission.nonDelegable))
const categories = computed(() => {
  const map = new Map<string, Permission[]>()
  for (const permission of delegable.value) map.set(permission.category, [...(map.get(permission.category) ?? []), permission])
  return [...map.entries()]
})

async function load() {
  loading.value = true
  error.value = null
  try {
    const [cat, access] = await Promise.all([
      api<{ permissions: Permission[] }>('/api/roles/catalog'),
      api<{ teams: Team[]; users: Staff[]; overrides: Override[] }>('/api/permission-teams'),
    ])
    catalog.value = cat.permissions
    teams.value = access.teams
    users.value = access.users
    overrides.value = access.overrides
  } catch (e) { error.value = e instanceof Error ? e.message : t('accessTeams.loadFailed') }
  finally { loading.value = false }
}

function selectTeam(id: string) {
  selectedTeamId.value = id
  const team = teams.value.find((item) => item.id === id)
  teamDraft.value = team ? { name: team.name, description: team.description ?? '', permissions: [...team.permissions], memberIds: [...team.memberIds] } : { name: '', description: '', permissions: [], memberIds: [] }
}

function toggle(list: 'permissions' | 'memberIds', value: string) {
  const set = new Set(teamDraft.value[list])
  if (set.has(value)) set.delete(value)
  else set.add(value)
  teamDraft.value[list] = [...set]
}

async function saveTeam() {
  if (!teamDraft.value.name.trim()) return
  saving.value = true; error.value = null; message.value = null
  try {
    const path = selectedTeamId.value ? `/api/permission-teams/${selectedTeamId.value}` : '/api/permission-teams'
    const method = selectedTeamId.value ? 'PATCH' : 'POST'
    const data = await api<{ teams: Team[]; users: Staff[]; overrides: Override[] }>(path, { method, body: JSON.stringify(teamDraft.value) })
    teams.value = data.teams; users.value = data.users; overrides.value = data.overrides
    const matching = data.teams.find((team) => team.name === teamDraft.value.name)
    selectTeam(matching?.id ?? '')
    message.value = t('accessTeams.teamSaved')
  } catch (e) { error.value = e instanceof Error ? e.message : t('accessTeams.teamSaveFailed') }
  finally { saving.value = false }
}

function selectUser(id: string) {
  selectedUserId.value = id
  const next: Record<string, 'inherit' | 'allow' | 'deny'> = {}
  for (const permission of delegable.value) next[permission.key] = 'inherit'
  for (const item of overrides.value.filter((override) => override.userId === id)) next[item.permissionKey] = item.effect
  overrideDraft.value = next
}

async function saveOverrides() {
  if (!selectedUserId.value) return
  saving.value = true; error.value = null; message.value = null
  try {
    const entries = Object.entries(overrideDraft.value).filter(([, effect]) => effect !== 'inherit').map(([permissionKey, effect]) => ({ permissionKey, effect }))
    const data = await api<{ teams: Team[]; users: Staff[]; overrides: Override[] }>(`/api/permission-teams/users/${selectedUserId.value}/overrides`, { method: 'PUT', body: JSON.stringify({ overrides: entries }) })
    teams.value = data.teams; users.value = data.users; overrides.value = data.overrides
    selectUser(selectedUserId.value)
    message.value = t('accessTeams.individualSaved')
  } catch (e) { error.value = e instanceof Error ? e.message : t('accessTeams.individualSaveFailed') }
  finally { saving.value = false }
}

onMounted(load)
</script>

<template>
  <CollapsibleSection class="mt-6" :title="t('accessTeams.title')" :description="t('accessTeams.description')" :default-open="false">
    <p v-if="loading" class="mt-4 text-xs text-slate-400">{{ t('accessTeams.loading') }}</p>
    <p v-if="error" class="mt-4 text-xs text-red-400">{{ error }}</p>
    <p v-if="message" class="mt-4 text-xs text-emerald-300">{{ message }}</p>
    <div v-if="!loading" class="mt-5 grid gap-6 xl:grid-cols-2">
      <section class="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
        <h4 class="font-bold text-white">{{ t('accessTeams.teams') }}</h4><p class="mt-1 text-xs text-slate-500">{{ t('accessTeams.teamsDescription') }}</p>
        <div class="mt-4 flex flex-wrap gap-2"><button type="button" class="rounded-lg border px-3 py-2 text-xs" :class="!selectedTeamId ? 'border-farm-green text-farm-green' : 'border-slate-700 text-slate-300'" @click="selectTeam('')">{{ t('accessTeams.newTeam') }}</button><button v-for="team in teams" :key="team.id" type="button" class="rounded-lg border px-3 py-2 text-xs" :class="selectedTeamId === team.id ? 'border-farm-green text-farm-green' : 'border-slate-700 text-slate-300'" @click="selectTeam(team.id)">{{ team.name }}</button></div>
        <div class="mt-4 grid gap-3"><label class="text-xs text-slate-400">{{ t('accessTeams.teamName') }}<input v-model="teamDraft.name" maxlength="80" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label><label class="text-xs text-slate-400">{{ t('accessTeams.purpose') }}<input v-model="teamDraft.description" maxlength="500" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label></div>
        <h5 class="mt-4 text-xs font-bold uppercase tracking-wide text-slate-400">{{ t('accessTeams.members') }}</h5><div class="mt-2 grid gap-2 sm:grid-cols-2"><label v-for="person in users" :key="person.id" class="flex min-h-10 items-center gap-2 rounded-lg border border-slate-800 px-3 text-xs text-slate-300"><input type="checkbox" :checked="teamDraft.memberIds.includes(person.id)" @change="toggle('memberIds', person.id)" />{{ person.name }}</label></div>
        <h5 class="mt-4 text-xs font-bold uppercase tracking-wide text-slate-400">{{ t('accessTeams.access') }}</h5><details v-for="[category, permissions] in categories" :key="category" class="mt-2 rounded-lg border border-slate-800 bg-slate-900/60"><summary class="min-h-11 cursor-pointer px-3 py-3 text-[11px] font-bold uppercase text-farm-gold">{{ category }} · {{ teamDraft.permissions.filter((key) => permissions.some((permission) => permission.key === key)).length }}/{{ permissions.length }}</summary><div class="grid gap-2 border-t border-slate-800 p-2"><label v-for="permission in permissions" :key="permission.key" class="flex min-h-10 items-start gap-2 rounded-lg border border-slate-800 px-3 py-2 text-xs text-slate-300"><input type="checkbox" class="mt-0.5" :checked="teamDraft.permissions.includes(permission.key)" @change="toggle('permissions', permission.key)" /><span><strong class="font-mono text-slate-200">{{ permission.key }}</strong><span class="block text-slate-500">{{ permission.description }}</span></span></label></div></details>
        <button type="button" :disabled="saving || !teamDraft.name.trim()" class="mt-4 min-h-11 rounded-xl bg-farm-green px-4 text-sm font-bold text-white disabled:opacity-50" @click="saveTeam">{{ saving ? t('accessTeams.saving') : t('accessTeams.saveTeam') }}</button>
      </section>

      <section class="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
        <h4 class="font-bold text-white">{{ t('accessTeams.individual') }}</h4><p class="mt-1 text-xs text-slate-500">{{ t('accessTeams.individualDescription') }}</p>
        <select class="mt-4 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" :value="selectedUserId" @change="selectUser(($event.target as HTMLSelectElement).value)"><option value="">{{ t('accessTeams.choosePerson') }}</option><option v-for="person in users" :key="person.id" :value="person.id">{{ person.name }} · {{ person.role }}</option></select>
        <div v-if="selectedUserId" class="mt-4 space-y-2"><details v-for="[category, permissions] in categories" :key="category" class="rounded-lg border border-slate-800 bg-slate-900/60"><summary class="min-h-11 cursor-pointer px-3 py-3 text-[11px] font-bold uppercase text-farm-gold">{{ category }}</summary><div class="space-y-2 border-t border-slate-800 p-2"><label v-for="permission in permissions" :key="permission.key" class="grid gap-2 rounded-lg border border-slate-800 p-3 text-xs sm:grid-cols-[1fr_130px]"><span><strong class="font-mono text-slate-200">{{ permission.key }}</strong><span class="block text-slate-500">{{ permission.description }}</span></span><select v-model="overrideDraft[permission.key]" class="min-h-10 rounded-lg border border-slate-700 bg-slate-900 px-2 text-white"><option value="inherit">{{ t('accessTeams.inherit') }}</option><option value="allow">{{ t('accessTeams.allow') }}</option><option value="deny">{{ t('accessTeams.deny') }}</option></select></label></div></details></div>
        <button v-if="selectedUserId" type="button" :disabled="saving" class="mt-4 min-h-11 rounded-xl bg-farm-green px-4 text-sm font-bold text-white disabled:opacity-50" @click="saveOverrides">{{ saving ? t('accessTeams.saving') : t('accessTeams.saveIndividual') }}</button>
      </section>
    </div>
  </CollapsibleSection>
</template>
