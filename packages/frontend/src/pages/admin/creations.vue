<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader>
	<div class="_spacer" style="--MI_SPACER-w: 900px;">
		<div class="_gaps_m">
			<MkInfo>{{ i18n.ts._creations.localOnly }}</MkInfo>
			<MkInfo v-if="state.lastError" warn>{{ errorMessage(state.lastError) }}</MkInfo>
			<div class="_gaps_s">
				<strong>{{ state.running ? i18n.ts._creations.running : i18n.ts._creations.stopped }}</strong>
				<span>{{ i18n.tsx._creations.budgetUsage({ month: state.month, used: state.spentJpy.toFixed(2), limit: state.monthlyLimitJpy }) }}</span>
				<div :class="$style.actions">
					<MkButton primary :disabled="busy || state.running" @click="operate({ action: 'start' })">{{ i18n.ts._creations.start }}</MkButton>
					<MkButton danger :disabled="busy || !state.running" @click="operate({ action: 'stop' })">{{ i18n.ts._creations.stop }}</MkButton>
					<MkButton :disabled="busy" @click="operate({ action: 'status' })">{{ i18n.ts.reload }}</MkButton>
				</div>
			</div>

			<MkFolder>
				<template #label>{{ i18n.ts._creations.provider }}</template>
				<div class="_gaps_m">
					<MkSelect v-model="provider" :items="[{ value: 'openai', label: 'OpenAI' }, { value: 'gemini', label: 'Gemini' }]" :disabled="state.running">
						<template #label>{{ i18n.ts._creations.provider }}</template>
					</MkSelect>
					<MkInput v-model="model" :disabled="state.running"><template #label>{{ i18n.ts._creations.model }}</template></MkInput>
					<MkInput v-model="inputRate" type="number" :min="0" :disabled="state.running"><template #label>{{ i18n.ts._creations.inputRate }}</template></MkInput>
					<MkInput v-model="outputRate" type="number" :min="0" :disabled="state.running"><template #label>{{ i18n.ts._creations.outputRate }}</template></MkInput>
					<MkInfo>{{ i18n.ts._creations.keys }} {{ state.providerKeyConfigured ? i18n.ts._creations.keyReady : i18n.ts._creations.keyMissing }}</MkInfo>
					<MkSwitch v-model="terms" :disabled="state.running">{{ i18n.ts._creations.providerTerms }}</MkSwitch>
					<MkButton primary :disabled="busy || state.running" @click="saveProvider">{{ i18n.ts.save }}</MkButton>
				</div>
			</MkFolder>

			<MkFolder :defaultOpen="state.catalog.length === 0">
				<template #label>{{ i18n.ts._creations.catalog }}</template>
				<div class="_gaps_m">
					<MkInput v-model="catalogPath" :disabled="state.running"><template #label>{{ i18n.ts._creations.catalogPath }}</template></MkInput>
					<MkInfo>{{ i18n.ts._creations.permissionInstructions }}</MkInfo>
					<MkButton :disabled="busy || state.running" @click="operate({ action: 'catalog', catalogPath })">{{ i18n.ts._creations.loadCatalog }}</MkButton>
				</div>
			</MkFolder>

			<MkFolder v-for="bot in state.botStatus" :key="bot.id">
				<template #label>{{ bot.id === 'aphr' ? 'APHRNTs_100' : 'Tarot-byFateLineDealer' }}</template>
				<div class="_gaps_m">
					<MkInfo>{{ i18n.ts._creations.botIsolation }}</MkInfo>
					<span>{{ bot.installed ? i18n.ts._creations.installed : i18n.ts._creations.notInstalled }} / {{ bot.keyConfigured ? i18n.ts._creations.keyReady : i18n.ts._creations.keyMissing }}</span>
					<span>{{ i18n.tsx._creations.budgetUsage({ month: state.month, used: bot.spentJpy.toFixed(2), limit: bot.budgetJpy }) }}</span>
					<MkInput v-model="bot.model"><template #label>{{ i18n.ts._creations.botModel }}</template></MkInput>
					<MkInput v-model="bot.budgetJpy" type="number" :min="0"><template #label>{{ i18n.ts._creations.botBudget }}</template></MkInput>
					<MkInput v-model="bot.estimatePerCallJpy" type="number" :min="0"><template #label>{{ i18n.ts._creations.botCost }}</template></MkInput>
					<MkSwitch v-model="bot.termsConfirmed">{{ i18n.ts._creations.botTerms }}</MkSwitch>
					<div :class="$style.actions">
						<MkButton primary :disabled="busy" @click="saveBot(bot, true)">{{ i18n.ts._creations.start }}</MkButton>
						<MkButton :disabled="busy" @click="saveBot(bot, false)">{{ i18n.ts._creations.stop }}</MkButton>
					</div>
				</div>
			</MkFolder>

			<MkInput v-model="search"><template #label>{{ i18n.ts.search }}</template></MkInput>
			<MkInfo>{{ i18n.ts._creations.characterInstructions }}</MkInfo>
			<div v-for="character in filtered.slice(0, shown)" :key="character.key" class="_panel _gaps_s" :class="$style.character">
				<strong>{{ character.name }}</strong>
				<small class="_selectable">{{ character.work }} / {{ character.db }}</small>
				<small class="_selectable">{{ character.key }}</small>
				<span>{{ permissionLabel(character.permission) }} — {{ character.reason }}</span>
				<MkA v-if="character.username" :to="`/@${character.username}`" class="_link">@{{ character.username }}</MkA>
				<MkSwitch :modelValue="character.enabled" :disabled="busy || (character.permission !== 'allowed' && !character.enabled)" @update:modelValue="enabled => saveCharacter(character, { enabled })">
					{{ i18n.ts._creations.enableCharacter }}
				</MkSwitch>
				<template v-if="character.userId">
					<MkSwitch :modelValue="character.spontaneous" :disabled="busy" @update:modelValue="spontaneous => saveCharacter(character, { spontaneous })">
						{{ i18n.ts._creations.spontaneous }}
					</MkSwitch>
					<MkSwitch :modelValue="character.functions.includes('aphr')" :disabled="busy" @update:modelValue="enabled => setFunction(character, 'aphr', enabled)">APHRNTs_100</MkSwitch>
					<MkSwitch :modelValue="character.functions.includes('tarot')" :disabled="busy" @update:modelValue="enabled => setFunction(character, 'tarot', enabled)">Tarot-byFateLineDealer</MkSwitch>
				</template>
			</div>
			<MkButton v-if="filtered.length > shown" @click="shown += 40">{{ i18n.ts.loadMore }}</MkButton>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { ref, computed, watch } from 'vue';
import type { Endpoints } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkInput from '@/components/MkInput.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { definePage } from '@/page.js';

type Status = Endpoints['admin/creations']['res'];
type Character = Status['catalog'][number];
type Bot = Status['botStatus'][number];
type Request = Endpoints['admin/creations']['req'];
const state = ref(await misskeyApi('admin/creations', { action: 'status' }));
const provider = ref(state.value.provider);
const model = ref(state.value.model);
const inputRate = ref(state.value.inputJpyPerMillion);
const outputRate = ref(state.value.outputJpyPerMillion);
const catalogPath = ref(state.value.catalogPath);
const terms = ref(state.value.termsConfirmed);
const busy = ref(false);
const search = ref('');
const shown = ref(40);
const filtered = computed(() => state.value.catalog.filter(character =>
	`${character.name} ${character.work} ${character.db}`.toLowerCase().includes(search.value.toLowerCase())));
watch(search, () => { shown.value = 40; });
watch(provider, value => {
	model.value = value === 'openai' ? 'gpt-4.1-mini' : 'gemini-2.5-flash';
	terms.value = false;
});

function permissionLabel(permission: Character['permission']): string {
	return permission === 'allowed' ? i18n.ts._creations.allowed :
		permission === 'denied' ? i18n.ts._creations.denied : i18n.ts._creations.unknown;
}

function errorMessage(code: string): string {
	const messages = i18n.ts._creations._errors;
	const description = code.includes('KEY_NOT_CONFIGURED') ? messages.key :
		code.includes('TERMS_NOT_CONFIRMED') ? messages.terms :
		code === 'MONTHLY_BUDGET_REACHED' ? messages.budget :
		code === 'BOT_BUDGET_REACHED' ? messages.botBudget :
		code.includes('COST_') || code.includes('BUDGET_') ? messages.cost :
		code.includes('PERMISSION') || code.includes('REFERENCE') ? messages.permission :
		code.includes('CATALOG') || code.includes('RECORD_') ? messages.catalog :
		code.includes('BOT_NOT_INSTALLED') || code.includes('BOT_INSTALLATION') ? messages.install :
		code.includes('STOP') || code.includes('CONFIGURATION_CHANGED') ? messages.stopped :
		code.includes('PROVIDER_') ? messages.provider :
		code.includes('ROUTING_') ? messages.routing : messages.general;
	return `${description} (${code})`;
}

async function operate(request: Request) {
	busy.value = true;
	try {
		state.value = await misskeyApi('admin/creations', request);
	} catch (error) {
		const detail = typeof error === 'object' && error && 'info' in error ? error.info : null;
		const reason = typeof detail === 'object' && detail && 'reason' in detail ? String(detail.reason) : i18n.ts.somethingHappened;
		await os.alert({ type: 'error', text: errorMessage(reason) });
	} finally {
		busy.value = false;
	}
}

async function saveProvider() {
	await operate({
		action: 'configure', provider: provider.value, model: model.value,
		inputJpyPerMillion: inputRate.value, outputJpyPerMillion: outputRate.value, termsConfirmed: terms.value,
	});
}

async function saveBot(bot: Bot, enabled: boolean) {
	if (!enabled) {
		await operate({ action: 'bot', bot: bot.id, enabled: false });
		return;
	}
	if (!(bot.budgetJpy > 0 && bot.estimatePerCallJpy > 0)) {
		await os.alert({ type: 'error', text: errorMessage('BOT_COST_UNKNOWN') });
		return;
	}
	await operate({
		action: 'bot', bot: bot.id, enabled, model: bot.model || undefined,
		resetModel: bot.model === '',
		budgetJpy: bot.budgetJpy, estimatePerCallJpy: bot.estimatePerCallJpy,
		termsConfirmed: bot.termsConfirmed,
	});
}

async function saveCharacter(character: Character, changes: Pick<Request, 'enabled' | 'spontaneous' | 'functions'>) {
	if (changes.enabled && !character.userId) {
		const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts._creations.createConfirm });
		if (canceled) return;
	}
	await operate({ action: 'character', characterKey: character.key, ...changes });
}

async function setFunction(character: Character, bot: 'aphr' | 'tarot', enabled: boolean) {
	await saveCharacter(character, { functions: enabled ? [...character.functions, bot] : character.functions.filter(value => value !== bot) });
}

definePage(() => ({ title: i18n.ts._creations.title, icon: 'ti ti-sparkles' }));
</script>

<style lang="scss" module>
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 12px;
}
.character {
	padding: 20px;
	overflow-wrap: anywhere;
}
</style>
