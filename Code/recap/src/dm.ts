import { assign, createActor, raise, setup, fromPromise} from "xstate";
import { speechstate } from "speechstate";
import type { Settings } from "speechstate";
import type { DMEvents, DMContext, Message} from "./types";
import { KEY } from "./azure";

const azureCredentials = {
  endpoint:
    "https://northeurope.api.cognitive.microsoft.com/sts/v1.0/issuetoken",
  key: KEY,
};

const settings: Settings = {
  azureCredentials: azureCredentials,
  azureRegion: "northeurope",
  asrDefaultCompleteTimeout: 0,
  asrDefaultNoInputTimeout: 5000,
  locale: "en-US",
  ttsDefaultVoice: "en-US-DavisNeural",
};

const dmMachine = setup({
  types: {
    /** you might need to extend these */
    context: {} as DMContext,
    events: {} as DMEvents,
  },
  actions: {
    sst_prepare: ({ context }) => context.spstRef.send({ type: "PREPARE" }),
    sst_listen: ({ context }) => context.spstRef.send({ type: "LISTEN" }),
  },
  actors:{
    getModels: fromPromise<any,null>(() => 
      fetch("http://localhost:11434/api/tags").then((response) =>
        response.json()
      )
    ),
    modelReply : fromPromise<any, Message[]> (({input}) => {
      const body = {
        model: "llama3:latest",
        stream: false,
        messages: input,
      };
      return fetch("http://localhost:11434/api/chat", {
        method: "POST",
        body: JSON.stringify(body),
      }).then((response) => response.json());
    }
    ) 
  },
}).createMachine({
  id: "DM",
  context: ({ spawn }) => ({
    spstRef: spawn(speechstate, { input: settings }),
    informationState: { latestMove: "ping" },
    lastResult: "",
    messages:[],
    ollamaModels:[],
  }),
  initial: "Prepare",
  states: {
    Prepare: {
      entry: "sst_prepare",
      on: {
        ASRTTS_READY: "GetModels",
      },
    },
    GetModels:{
      invoke:{
        src:"getModels",
        input: null,
        onDone:{
          target: "Main",
          actions: assign(({ event }) => {
              return {
              ollamaModels:event.output.models.map((x:any) => x.name)
            }
          })
        }
      },
    },
    Main: {
      initial: "Prompt",
      states:{
        Prompt: { 
          entry: assign(({ context }) => ({
            messages: [
              {
                role: "assistant",
                content: `Hello! The models are ${context.ollamaModels?.join(" ")}`
              },
              ...context.messages
            ]
          })),
          on:{
            CLICK : "SpeakPrompt"
          }
        },
      
      SpeakPrompt: {
        entry: ({ context }) =>
          context.spstRef.send({
            type: "SPEAK",
            value: { utterance: context.messages[0].content },
          }),
        on: { SPEAK_COMPLETE: "Ask" }
      },

      Ask: {
        entry: "sst_listen",
        on: {
          LISTEN_COMPLETE:{
            target:"ChatCompletion"
          },
          RECOGNISED:{
            actions: assign(({ event, context }) => ({
              messages: [{
                role: "user", 
                content: event.value[0].utterance
              }, 
              ...context.messages],
            })),
          },
          ASR_NOINPUT: {
            target:"Reprompt",
          }
          
        },
      },

      ChatCompletion:{
        invoke:{
          src: "modelReply",
          input: (context) => context.context.messages,
          onDone:{
            target: "Speaking",
            actions: assign(({event, context}) => {
              console.log("Model reply event:", event.output);
              return {
                messages:[
                  {
                    role:"assistant",
                    content: event.output.message.content
                  },
                  ...context.messages]
              }
            })
          }
        }
      },

      Speaking: {
        entry: ({ context }) =>
            context.spstRef.send({
              type: "SPEAK",
              value: { utterance: context.messages[0].content },
            }),
      on: {SPEAK_COMPLETE: "Ask"}
      },

      Reprompt: {
        entry: ({ context }) =>
          context.spstRef.send({
            type: "SPEAK",
            value: { utterance: "I can't hear you." },
          }),
        on: { SPEAK_COMPLETE: "Ask" }, 
      },

      },
    },
  },
});

const dmActor = createActor(dmMachine, {}).start();

dmActor.subscribe((state) => {
  console.group("State update");
  console.log("State value:", state.value);
  console.log("State context:", state.context);
  console.groupEnd();
});

export function setupButton(element: HTMLButtonElement) {
  element.addEventListener("click", () => {
    dmActor.send({ type: "CLICK" });
  });
  dmActor.subscribe((snapshot) => {
    const meta: { view?: string } = Object.values(
      snapshot.context.spstRef.getSnapshot().getMeta()
    )[0] || {
      view: undefined,
    };
    element.innerHTML = `${meta.view}`;
  });
}
