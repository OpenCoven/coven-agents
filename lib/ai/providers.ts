import { customProvider, gateway } from "ai";
import { isTestEnvironment } from "../constants";
import { chatModels, titleModel } from "./models";

export const myProvider = isTestEnvironment
  ? (() => {
      const {
        chatModel,
        titleModel: mockTitleModel,
      }: typeof import("./models.mock") = require("./models.mock");
      return customProvider({
        languageModels: {
          ...Object.fromEntries(chatModels.map(({ id }) => [id, chatModel])),
          "chat-model": chatModel,
          "title-model": mockTitleModel,
        },
      });
    })()
  : null;

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  return gateway.languageModel(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return gateway.languageModel(titleModel.id);
}
