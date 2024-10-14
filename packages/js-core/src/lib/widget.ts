import { FormbricksAPI } from "@formbricks/api";
import { ResponseQueue } from "@formbricks/lib/responseQueue";
import { SurveyState } from "@formbricks/lib/surveyState";
import { getStyling } from "@formbricks/lib/utils/styling";
import { TJsFileUploadParams, TJsPersonState, TJsTrackProperties } from "@formbricks/types/js";
import { TResponseHiddenFieldValue, TResponseUpdate } from "@formbricks/types/responses";
import { TUploadFileConfig } from "@formbricks/types/storage";
import { TSurvey } from "@formbricks/types/surveys/types";
import { Config } from "./config";
import { CONTAINER_ID } from "./constants";
import { Logger } from "./logger";
import {
  filterSurveys,
  getDefaultLanguageCode,
  getLanguageCode,
  handleHiddenFields,
  shouldDisplayBasedOnPercentage,
} from "./utils";

const config = Config.getInstance();
const logger = Logger.getInstance();
let isSurveyRunning = false;
let setIsError = (_: boolean) => {};
let setIsResponseSendingFinished = (_: boolean) => {};

export const setIsSurveyRunning = (value: boolean) => {
  isSurveyRunning = value;
};

export const triggerSurvey = async (
  survey: TSurvey,
  action?: string,
  properties?: TJsTrackProperties
): Promise<void> => {
  // Check if the survey should be displayed based on displayPercentage
  if (survey.displayPercentage) {
    const shouldDisplaySurvey = shouldDisplayBasedOnPercentage(survey.displayPercentage);
    if (!shouldDisplaySurvey) {
      logger.debug(`Survey display of "${survey.name}" skipped based on displayPercentage.`);
      return; // skip displaying the survey
    }
  }

  const hiddenFieldsObject: TResponseHiddenFieldValue = handleHiddenFields(
    survey.hiddenFields,
    properties?.hiddenFields
  );

  await renderWidget(survey, action, hiddenFieldsObject);
};

const renderWidget = async (
  survey: TSurvey,
  action?: string,
  hiddenFields: TResponseHiddenFieldValue = {}
) => {
  if (isSurveyRunning) {
    logger.debug("A survey is already running. Skipping.");
    return;
  }
  setIsSurveyRunning(true);

  if (survey.delay) {
    logger.debug(`Delaying survey "${survey.name}" by ${survey.delay} seconds.`);
  }

  const { product } = config.get().environmentState.data ?? {};
  const { attributes } = config.get().personState.data ?? {};

  const isMultiLanguageSurvey = survey.languages.length > 1;
  let languageCode = "default";

  if (isMultiLanguageSurvey) {
    const displayLanguage = getLanguageCode(survey, attributes);
    //if survey is not available in selected language, survey wont be shown
    if (!displayLanguage) {
      logger.debug(`Survey "${survey.name}" is not available in specified language.`);
      setIsSurveyRunning(true);
      return;
    }
    languageCode = displayLanguage;
  }

  const surveyState = new SurveyState(survey.id, null, null, config.get().personState.data.userId);

  const responseQueue = new ResponseQueue(
    {
      apiHost: config.get().apiHost,
      environmentId: config.get().environmentId,
      retryAttempts: 2,
      onResponseSendingFailed: () => {
        setIsError(true);
      },
      onResponseSendingFinished: () => {
        setIsResponseSendingFinished(true);
      },
    },
    surveyState
  );
  const productOverwrites = survey.productOverwrites ?? {};
  const clickOutside = productOverwrites.clickOutsideClose ?? product.clickOutsideClose;
  const darkOverlay = productOverwrites.darkOverlay ?? product.darkOverlay;
  const placement = productOverwrites.placement ?? product.placement;
  const isBrandingEnabled = product.inAppSurveyBranding;
  const formbricksSurveys = await loadFormbricksSurveysExternally();

  setTimeout(() => {
    formbricksSurveys.renderSurveyModal({
      survey,
      isBrandingEnabled,
      clickOutside,
      darkOverlay,
      languageCode,
      placement,
      styling: getStyling(product, survey),
      getSetIsError: (f: (value: boolean) => void) => {
        setIsError = f;
      },
      getSetIsResponseSendingFinished: (f: (value: boolean) => void) => {
        setIsResponseSendingFinished = f;
      },
      onDisplay: async () => {
        const { userId } = config.get().personState.data;

        const api = new FormbricksAPI({
          apiHost: config.get().apiHost,
          environmentId: config.get().environmentId,
        });

        const res = await api.client.display.create({
          surveyId: survey.id,
          ...(userId && { userId }),
        });

        if (!res.ok) {
          throw new Error("Could not create display");
        }

        const { id } = res.data;

        surveyState.updateDisplayId(id);
        responseQueue.updateSurveyState(surveyState);

        const existingDisplays = config.get().personState.data.displays;
        const newDisplay = { surveyId: survey.id, createdAt: new Date() };
        const displays = existingDisplays ? [...existingDisplays, newDisplay] : [newDisplay];
        const previousConfig = config.get();

        const updatedPersonState: TJsPersonState = {
          ...previousConfig.personState,
          data: {
            ...previousConfig.personState.data,
            displays,
            lastDisplayAt: new Date(),
          },
        };

        const filteredSurveys = filterSurveys(previousConfig.environmentState, updatedPersonState);

        config.update({
          ...previousConfig,
          environmentState: previousConfig.environmentState,
          personState: updatedPersonState,
          filteredSurveys,
        });
      },
      onResponse: (responseUpdate: TResponseUpdate) => {
        const { userId } = config.get().personState.data;

        const isNewResponse = surveyState.responseId === null;

        if (userId) {
          surveyState.updateUserId(userId);
        }

        responseQueue.updateSurveyState(surveyState);
        responseQueue.add({
          data: responseUpdate.data,
          ttc: responseUpdate.ttc,
          finished: responseUpdate.finished,
          language:
            responseUpdate.language === "default" ? getDefaultLanguageCode(survey) : responseUpdate.language,
          meta: {
            url: window.location.href,
            action,
          },
          variables: responseUpdate.variables,
          hiddenFields,
          displayId: surveyState.displayId,
        });

        if (isNewResponse) {
          const responses = config.get().personState.data.responses;
          const newPersonState: TJsPersonState = {
            ...config.get().personState,
            data: {
              ...config.get().personState.data,
              responses: [...responses, surveyState.surveyId],
            },
          };

          const filteredSurveys = filterSurveys(config.get().environmentState, newPersonState);

          config.update({
            ...config.get(),
            environmentState: config.get().environmentState,
            personState: newPersonState,
            filteredSurveys,
          });
        }
      },
      onClose: closeSurvey,
      onFileUpload: async (file: TJsFileUploadParams["file"], params: TUploadFileConfig) => {
        const api = new FormbricksAPI({
          apiHost: config.get().apiHost,
          environmentId: config.get().environmentId,
        });

        return await api.client.storage.uploadFile(
          {
            type: file.type,
            name: file.name,
            base64: file.base64,
          },
          params
        );
      },
      onRetry: () => {
        setIsError(false);
        responseQueue.processQueue();
      },
      hiddenFieldsRecord: hiddenFields,
    });
  }, survey.delay * 1000);
};

export const closeSurvey = async (): Promise<void> => {
  // remove container element from DOM
  removeWidgetContainer();
  addWidgetContainer();

  const { environmentState, personState } = config.get();
  const filteredSurveys = filterSurveys(environmentState, personState);

  config.update({
    ...config.get(),
    environmentState,
    personState,
    filteredSurveys,
  });

  setIsSurveyRunning(false);
};

export const addWidgetContainer = (): void => {
  const containerElement = document.createElement("div");
  containerElement.id = CONTAINER_ID;
  document.body.appendChild(containerElement);
};

export const removeWidgetContainer = (): void => {
  document.getElementById(CONTAINER_ID)?.remove();
};

const loadFormbricksSurveysExternally = (): Promise<typeof window.formbricksSurveys> => {
  return new Promise((resolve, reject) => {
    if (window.formbricksSurveys) {
      resolve(window.formbricksSurveys);
    } else {
      const script = document.createElement("script");
      script.src = `${config.get().apiHost}/js/surveys.umd.cjs`;
      script.async = true;
      script.onload = () => resolve(window.formbricksSurveys);
      script.onerror = (error) => {
        console.error("Failed to load Formbricks Surveys library:", error);
        reject(error);
      };
      document.head.appendChild(script);
    }
  });
};