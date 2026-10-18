import type { CareStore, FamilyMessage } from '../store/types.js';

export type Outgoing = Omit<FamilyMessage, 'delivery'>;

/** Sends a family message. The in-app inbox always gets it; SNS is added when configured. */
export interface Notifier {
  send(message: Outgoing): Promise<FamilyMessage>;
  /** For health checks and the tool's spoken reply */
  readonly snsEnabled: boolean;
}

/** Publishes to an Amazon SNS topic. Family members subscribe by email or SMS. */
export interface SnsPublisher {
  publish(input: { subject: string; text: string }): Promise<string | undefined>;
}

export function snsPublisher(topicArn: string, region?: string): SnsPublisher {
  // Loaded on first use so servers without a topic never touch the AWS SDK.
  let client: Promise<{ send: (cmd: unknown) => Promise<{ MessageId?: string }>; cmd: (input: object) => unknown }> | undefined;
  const load = () =>
    (client ??= import('@aws-sdk/client-sns').then(({ SNSClient, PublishCommand }) => {
      const sns = new SNSClient(region ? { region } : {});
      return { send: (cmd: unknown) => sns.send(cmd as InstanceType<typeof PublishCommand>), cmd: (input: object) => new PublishCommand(input as never) };
    }));
  return {
    async publish({ subject, text }) {
      const sns = await load();
      // SNS email subjects must be ASCII and at most 100 characters.
      const ascii = subject.replace(/[^\x20-\x7E]/g, '').slice(0, 100) || 'CareCircle';
      const out = await sns.send(sns.cmd({ TopicArn: topicArn, Subject: ascii, Message: text }));
      return out.MessageId;
    }
  };
}

export function createNotifier(store: CareStore, sns?: SnsPublisher): Notifier {
  return {
    snsEnabled: Boolean(sns),
    async send(message) {
      let delivery: FamilyMessage['delivery'] = { inbox: true, sns: 'off' };
      if (sns) {
        try {
          const id = await sns.publish({ subject: message.title, text: message.text });
          delivery = { inbox: true, sns: 'sent', ...(id ? { snsMessageId: id } : {}) };
        } catch (err) {
          console.error('[carecircle] SNS publish failed', err);
          delivery = { inbox: true, sns: 'failed', snsError: String((err as Error).message ?? err).slice(0, 200) };
        }
      }
      const full: FamilyMessage = { ...message, delivery };
      await store.addMessage(full);
      return full;
    }
  };
}
