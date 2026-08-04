import { tool } from 'ai';
import { z } from 'zod';

export function energyTariffsSkill({ workspaces, energyTariffStatus, prepareWorkspaceEnergyTariffRequest }) {
  return {
    getEnergyTariffConnectorStatus: tool({
      description: 'Prueft, ob IVAs Strom-/Gas-Tarifportal technisch verbunden ist. Gibt niemals Zugangsdaten aus.',
      parameters: z.object({}),
      execute: async () => energyTariffStatus(),
    }),
    prepareEnergyTariffComparison: tool({
      description: 'Bereitet fuer eine bestehende IVA-Fallakte einen belegpflichtigen Strom- oder Gas-Tarifvergleich vor. Nutzt die Kundenadresse aus der Akte, wenn keine Adresse genannt wird. Solange der Provider-Adapter nicht verifiziert ist, wird ausdruecklich nur ein Portal-Handoff erzeugt und kein Tarif erfunden.',
      parameters: z.object({
        workspaceId: z.string(),
        commodity: z.enum(['electricity', 'gas']),
        annualConsumptionKwh: z.number().positive().optional(),
        customerAddress: z.string().optional(),
        postalCode: z.string().optional(),
        city: z.string().optional(),
        meterType: z.string().optional(),
        currentSupplier: z.string().optional(),
        currentTariff: z.string().optional(),
        desiredStartDate: z.string().optional(),
        notes: z.string().optional(),
      }),
      execute: async input => await prepareWorkspaceEnergyTariffRequest({ workspaces, workspaceId: input.workspaceId, input }),
    }),
  };
}

export const energyTariffsSkillMeta = {
  id: 'energyTariffs',
  toolNames: ['getEnergyTariffConnectorStatus', 'prepareEnergyTariffComparison'],
};

