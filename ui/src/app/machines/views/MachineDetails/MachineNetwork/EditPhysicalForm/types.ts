import type { NetworkValues } from "../NetworkFields/NetworkFields";

import type { NetworkInterface, NetworkLink } from "app/store/machine/types";

export type EditPhysicalValues = {
  interface_speed: NetworkInterface["interface_speed"];
  link_id: NetworkLink["id"] | "";
  link_speed: NetworkInterface["link_speed"];
  mac_address: NetworkInterface["mac_address"];
  name?: NetworkInterface["name"];
  tags?: NetworkInterface["tags"];
} & NetworkValues;
