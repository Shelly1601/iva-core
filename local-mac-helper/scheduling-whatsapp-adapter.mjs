import { readExactWhatsAppGroupMessage, sendExactWhatsAppGroupMessage } from './whatsapp-mac.mjs';
export function createSchedulingWhatsAppAdapter({ read = readExactWhatsAppGroupMessage, send = sendExactWhatsAppGroupMessage } = {}) {
  const inspect = async message => {
    const proof = await read({chatName:message.group,message:message.text,expectedInfoMarker:message.community});
    return {...proof,app:'native-whatsapp',community:message.community,group:message.group,text:message.text};
  };
  return {
    find: inspect,
    send: async message => {
      await send({chatName:message.group,message:message.text,expectedInfoMarker:message.community});
      const proof=await inspect(message);
      if(!proof.verified||!proof.messageId)throw Error('WhatsApp send has no visible message receipt');
      return proof;
    },
    read: async (target,message) => {
      const proof=await inspect(message);
      if(!proof.verified||!proof.messageId)throw Error('WhatsApp message no longer visible');
      // Accessibility descriptions can include relative timestamps. Persist the
      // first observed evidence identifier once a matching message is reread.
      return {...proof,messageId:target.messageId||proof.messageId};
    },
  };
}
