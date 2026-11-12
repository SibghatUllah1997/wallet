// Copyright (c) 2025-2026 Digital Asset (Switzerland) GmbH and/or its affiliates. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, type Page, test } from '@playwright/test'
import {
    OTCTradeV2,
    type OTCTradeV2Setup,
} from '@canton-network/core-wallet-test-utils'
import type { WalletGateway } from '@canton-network/core-wallet-test-utils'
import {
    amuletSupportsApi,
    createGatewayApi,
    connectGateway,
    createWalletGateway,
    expectHistoryRow,
    gotoConnect,
    gotoOffers,
    gotoWalletHistory,
    setupRegistry,
    switchWallet,
    tap,
    workerClientId,
} from './utils'

// Amounts (OTCTradeV2 defaults): Alice sends 10 to Bob, Bob sends 2 to Alice,
// Bob sends 0.5 to Carol. Net per trader: Alice -8, Bob +7.5, Carol +0.5.
// V2 locks only the net amount sent, so only Alice locks anything (8).

const setupOtcTradeV2 = async (page: Page) => {
    const rnd = Math.floor(Math.random() * 100000)
    const wg = createWalletGateway(page)

    const hints = {
        venue: `venue-${rnd}`,
        alice: `alice-${rnd}`,
        bob: `bob-${rnd}`,
        carol: `carol-${rnd}`,
    }

    // Scaffolding: parties are created through the wallet's API
    const api = await createGatewayApi()
    const venue = await api.createWallet({
        partyHint: hints.venue,
        signingProvider: 'participant',
    })
    const alice = await api.createWallet({
        partyHint: hints.alice,
        signingProvider: 'participant',
        primary: true,
    })
    const bob = await api.createWallet({
        partyHint: hints.bob,
        signingProvider: 'participant',
    })
    const carol = await api.createWallet({
        partyHint: hints.carol,
        signingProvider: 'participant',
    })

    await gotoConnect(page)
    await connectGateway(page, wg)
    await setupRegistry(page)

    const otcTrade = new OTCTradeV2({
        venue,
        alice,
        bob,
        carol,
        clientId: workerClientId(),
    })
    const trade = await otcTrade.setup()

    return { wg, api, otcTrade, trade, alice, bob, carol, hints }
}

/** The V2 request row on Offers; its aria label names the settlement */
const requestRow = (page: Page, trade: OTCTradeV2Setup) =>
    page.getByRole('button', {
        name: `Open Allocation Request ${trade.settlement.id}`,
        exact: true,
    })

/** The active V2 allocation row on Offers ("Awaiting Settlement") */
const allocationRow = (page: Page, trade: OTCTradeV2Setup) =>
    page.getByRole('button', {
        name: `Open Allocation ${trade.settlement.id}`,
        exact: true,
    })

/**
 * Accept a V2 request in the portfolio. Accepting is several gateway
 * submissions (one allocation per spec, then the accept), so the gateway
 * asks for approval once per submission.
 *
 * ASSUMPTION: approveTransaction(trigger) runs the trigger and approves the
 * next request; a no-op trigger approves one that is already on its way.
 * Adjust to the WalletGateway helper's actual API.
 */
const acceptRequest = async (
    page: Page,
    wg: WalletGateway,
    trade: OTCTradeV2Setup,
    { submissions = 2 } = {}
) => {
    await gotoOffers(page)
    const row = requestRow(page, trade)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()

    const dialog = page.getByRole('dialog')
    await expect(
        dialog.getByRole('heading', { name: 'Allocation Request' })
    ).toBeVisible()

    await wg.approveTransaction(() =>
        dialog.getByRole('button', { name: 'Accept' }).click()
    )
    for (let i = 1; i < submissions; i++) {
        await wg.approveTransaction(async () => {})
    }

    await expect(dialog).not.toBeVisible({ timeout: 30_000 })
    await expect(row).toHaveCount(0, { timeout: 30_000 })
}

test.describe('OTC allocations V2', () => {
    // Setup, taps, three accepts and a settlement
    test.setTimeout(240_000)

    test.beforeEach(async () => {
        test.skip(
            !(await amuletSupportsApi('splice-api-token-allocation-v2')),
            'Registry does not support token standard v2 allocations'
        )
    })

    test('every trader accepts in the UI and the trade settles', async ({
        page,
    }) => {
        const { wg, api, otcTrade, trade, alice, bob, carol, hints } =
            await setupOtcTradeV2(page)

        // Alice: the only trader who locks funds
        await tap(page, wg, '100')

        await gotoOffers(page)
        await requestRow(page, trade).click()
        const dialog = page.getByRole('dialog')
        await expect(
            dialog.getByText('8 Amulet', { exact: true })
        ).toBeVisible() // you lock: net, not 10
        await dialog.getByLabel('Close allocation request dialog').click()

        await acceptRequest(page, wg, trade)
        await expect(allocationRow(page, trade)).toContainText(
            'Awaiting Settlement',
            {
                timeout: 30_000,
            }
        )

        // Bob receives more than he sends: nothing to lock, so no tap needed
        await switchWallet(api, bob)
        await acceptRequest(page, wg, trade)

        // Carol only receives
        await switchWallet(api, carol)
        await gotoOffers(page)
        await requestRow(page, trade).click()
        await expect(
            page.getByRole('dialog').getByText('Nothing — you only receive')
        ).toBeVisible()
        await page
            .getByRole('dialog')
            .getByLabel('Close allocation request dialog')
            .click()
        await acceptRequest(page, wg, trade)

        // Venue settles once every leg is covered
        await otcTrade.settle(trade)

        await gotoWalletHistory(page, alice, hints.alice)
        await expectHistoryRow(page, {
            activity: 'Allocation reserved',
            amount: '8',
            counterpartyHint: hints.bob,
        })
        await expectHistoryRow(page, {
            activity: 'Trade settled',
            amount: '-8',
            counterpartyHint: hints.bob,
        })

        await gotoWalletHistory(page, bob, hints.bob)
        await expectHistoryRow(page, {
            activity: 'Trade settled',
            amount: '+7.5',
            counterpartyHint: 'Multiple',
        })

        await gotoWalletHistory(page, carol, hints.carol)
        await expectHistoryRow(page, {
            activity: 'Trade settled',
            amount: '+0.5',
            counterpartyHint: hints.bob,
        })

        // Nothing left to act on
        await gotoOffers(page)
        await expect(requestRow(page, trade)).toHaveCount(0)
        await expect(allocationRow(page, trade)).toHaveCount(0)
    })

    test('rejecting a request removes it', async ({ page }) => {
        const { wg, trade } = await setupOtcTradeV2(page)

        await gotoOffers(page)
        const row = requestRow(page, trade)
        await expect(row).toBeVisible({ timeout: 30_000 })
        await row.click()

        const dialog = page.getByRole('dialog')
        await wg.approveTransaction(() =>
            dialog.getByRole('button', { name: 'Reject' }).click()
        )

        await expect(dialog).not.toBeVisible({ timeout: 30_000 })
        await expect(row).toHaveCount(0, { timeout: 30_000 })
    })

    test('withdrawing an allocation releases the funds', async ({ page }) => {
        const { wg, trade, alice, hints } = await setupOtcTradeV2(page)

        await tap(page, wg, '100')
        await acceptRequest(page, wg, trade)

        const row = allocationRow(page, trade)
        await expect(row).toBeVisible({ timeout: 30_000 })
        await row.click()

        const dialog = page.getByRole('dialog')
        await expect(
            dialog.getByRole('heading', { name: 'Allocation' })
        ).toBeVisible()
        await dialog.getByRole('button', { name: 'Withdraw' }).click()
        await wg.approveTransaction(() =>
            dialog.getByRole('button', { name: 'Withdraw allocation' }).click()
        )

        await expect(dialog).not.toBeVisible({ timeout: 30_000 })
        await expect(row).toHaveCount(0, { timeout: 30_000 })

        await gotoWalletHistory(page, alice, hints.alice)
        await expectHistoryRow(page, {
            activity: 'Allocation reserved',
            amount: '8',
            counterpartyHint: hints.bob,
        })
        await expectHistoryRow(page, {
            activity: 'Allocation withdrawn',
            amount: '8',
            counterpartyHint: 'Self',
        })
    })
})
