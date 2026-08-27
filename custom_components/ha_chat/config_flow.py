"""Config flow for the HA Chat integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback

from .const import (
    CONF_CONTEXT_WINDOW,
    CONF_LLM_API_KEY,
    CONF_LLM_URL,
    CONF_MCP_TOKEN,
    CONF_MCP_URL,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_LLM_URL,
    DOMAIN,
)


def _schema(defaults: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_LLM_URL, default=defaults.get(CONF_LLM_URL, DEFAULT_LLM_URL)
            ): str,
            vol.Optional(
                CONF_LLM_API_KEY,
                description={"suggested_value": defaults.get(CONF_LLM_API_KEY, "")},
            ): str,
            vol.Required(CONF_MCP_URL, default=defaults.get(CONF_MCP_URL, "")): str,
            vol.Optional(
                CONF_MCP_TOKEN,
                description={"suggested_value": defaults.get(CONF_MCP_TOKEN, "")},
            ): str,
            vol.Required(
                CONF_CONTEXT_WINDOW,
                default=defaults.get(CONF_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW),
            ): vol.All(vol.Coerce(int), vol.Range(min=1024)),
        }
    )


def _validate(user_input: dict[str, Any]) -> dict[str, str]:
    errors: dict[str, str] = {}
    if not user_input[CONF_LLM_URL].startswith(("http://", "https://")):
        errors[CONF_LLM_URL] = "invalid_llm_url"
    if not user_input[CONF_MCP_URL].startswith(
        ("http://", "https://", "ws://", "wss://")
    ):
        errors[CONF_MCP_URL] = "invalid_mcp_url"
    return errors


class HaChatConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial setup of HA Chat."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                return self.async_create_entry(title="HA Chat", data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=_schema(user_input or {}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> HaChatOptionsFlow:
        return HaChatOptionsFlow()


class HaChatOptionsFlow(OptionsFlow):
    """Edit the LLM / MCP settings after setup."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                return self.async_create_entry(title="", data=user_input)

        current = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(
            step_id="init",
            data_schema=_schema(user_input or current),
            errors=errors,
        )
