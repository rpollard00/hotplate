#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
exec 2>/dev/null

refuse() { printf '%s\n' 'Deployment refused. Inspect status and private journal.' >&2; exit 1; }
json() { jq -ce "$@"; }
hash() { sha256sum "$1" | cut -d ' ' -f1; }
atomic() { local destination=$1; cat > "$destination.next"; chmod 600 "$destination.next"; mv -T "$destination.next" "$destination"; }
result() { jq -cn --arg state "$1" --arg operation "${operation:-}" '{kind:"Result",state:$state,operation:$operation}'; }

IFS= read -r -t 30 request
[[ ${#request} -le 1048576 && $(id -u) == 0 ]] || refuse
printf '%s' "$request" | json '
  (keys == ["command","operation","release","secrets","target"]) and
  (.command == "plan" or .command == "status" or .command == "apply") and
  (.operation | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
  (.target | keys == ["address","appdata","hostName","installation","network","networkDriver","origin","version"]) and
  (.target.version == 1) and
  (.target.installation | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
  (.target.appdata | test("^/([A-Za-z0-9_-][A-Za-z0-9._-]*/)+[A-Za-z0-9_-][A-Za-z0-9._-]*$")) and
  (.target.hostName | test("^[A-Za-z0-9][A-Za-z0-9.-]*$")) and
  (.target.network | test("^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")) and
  (.target.networkDriver == "macvlan" or .target.networkDriver == "bridge") and
  (.target.address | split(".") | length == 4 and all(.[]; test("^(0|[1-9][0-9]{0,2})$") and tonumber <= 255)) and
  (.target.origin == ("http://" + .target.address + ":7345"))' >/dev/null || refuse
command=$(jq -r .command <<< "$request")
target=$(jq -cS .target <<< "$request")
installation=$(jq -r .installation <<< "$target")
appdata=$(jq -r .appdata <<< "$target")
network=$(jq -r .network <<< "$target")
address=$(jq -r .address <<< "$target")
operation=$(jq -r .operation <<< "$request")
release=$(jq -c .release <<< "$request")
target_hash=$(printf '%s' "$target" | sha256sum | cut -d ' ' -f1)
[[ $(hostname) == "$(jq -r .hostName <<< "$target")" ]] || refuse
[[ $(realpath -e "$(dirname "$appdata")") == "$(dirname "$appdata")" ]] || refuse
[[ ! -L $appdata ]] || refuse
for tool in docker jq tar sha256sum flock realpath stat df head base64 timeout; do command -v "$tool" >/dev/null || refuse; done
[[ $(docker info --format '{{.OSType}}/{{.Architecture}}') == linux/x86_64 ]] || refuse

private_directory() { [[ -d $1 && ! -L $1 && $(realpath -e "$1") == "$1" && $(stat -c '%u:%a' "$1") == 0:700 ]]; }
private_file() { [[ -f $1 && ! -L $1 && $(stat -c '%u:%a:%h' "$1") == 0:600:1 ]]; }
network_info=$(docker network inspect "$network")
network_id=$(jq -er '.[0].Id' <<< "$network_info")
[[ $(jq -r '.[0].Driver' <<< "$network_info") == "$(jq -r .networkDriver <<< "$target")" ]] || refuse
jq -e --arg address "$address" '
  def ip: split(".") | map(tonumber) | .[0]*16777216 + .[1]*65536 + .[2]*256 + .[3];
  .[0] | .Scope == "local" and .Internal == false and
  any(.IPAM.Config[]; .Subnet | select(contains(":" ) | not) | split("/") |
    (.[1] | tonumber) as $bits | (pow(2;32-$bits)) as $size |
    ((.[0]|ip)/$size|floor) == (($address|ip)/$size|floor) and
    (($address|ip)%$size) > 0 and (($address|ip)%$size) < ($size-1)) and
  all(.IPAM.Config[]; .Gateway != $address)' <<< "$network_info" >/dev/null || refuse

if [[ $command == apply ]]; then
  if [[ ! -e /run/hotplate-deploy ]]; then mkdir -m 700 /run/hotplate-deploy; fi
  private_directory /run/hotplate-deploy || refuse
  lock_key=$(printf '%s' "$appdata" | sha256sum | cut -d ' ' -f1)
  lock=/run/hotplate-deploy/$lock_key
  [[ ! -L $lock ]] || refuse
  if [[ ! -e $lock ]]; then (set -o noclobber; : > "$lock"); fi
  private_file "$lock" || refuse
  exec 9<> "$lock"
  flock -n 9 || refuse
fi

journal=$appdata/journal.json
state=Ready
current=
validate_journal() {
  private_file "$journal" || refuse
  jq -e --arg installation "$installation" '
    def uuid: type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    def sha: type == "string" and test("^[0-9a-f]{64}$");
    def image: type == "string" and test("^sha256:[0-9a-f]{64}$");
    def release: .version == 1 and .platform == "linux/amd64" and (.imageId|image) and
      (.archiveSha256|sha) and (.controllerSha256|sha) and (.archiveBytes|type == "number" and . > 0);
    def previous: if .kind == "Absent" then keys == ["kind"] else
      .kind == "Container" and (.id|sha) and (.imageId|image) and (.specSha256|sha) and
      .restart == {Name:"unless-stopped",MaximumRetryCount:0} end;
    def backup: (.sha256|sha) and (.path|type == "string");
    def operation: (.operation|uuid) and (.release|release) and (.previous|previous) and
      (if has("runtimeImageId") then (.runtimeImageId|image) else true end);
    def lifecycle:
      .installation == $installation and
      (if .state == "Ready" then keys == ["installation","state"]
      elif .state == "Prepared" then operation
      elif .state == "StopIntent" then operation and .previous.kind == "Container"
      elif .state == "BackupReady" then operation and (.backup|backup)
      elif .state == "StartIntent" then operation and (.backup|backup) and
        (.candidateName|type == "string") and (if has("candidate") then (.candidate|sha) else true end)
      elif .state == "Healthy" then operation and (.backup|backup) and
        (.candidateName|type == "string") and (.candidate|sha) and .acknowledged == .candidate
      else false end);
    if .state == "RecoveryRequired" then .installation == $installation and (.evidence|lifecycle) and .evidence.state != "Ready"
    else lifecycle end' "$journal" >/dev/null || refuse
  state=$(jq -r .state "$journal")
  if [[ $state != Ready ]]; then
    local evidence op directory
    evidence=$(jq -c 'if .state == "RecoveryRequired" then .evidence else . end' "$journal")
    op=$(jq -r .operation <<< "$evidence")
    directory=$appdata/operations/$op
    private_directory "$directory" || refuse
    private_file "$directory/release.json" || refuse
    [[ $(hash "$directory/release.json") == "$(jq -c .release <<< "$evidence" | sha256sum | cut -d ' ' -f1)" ]] || refuse
    if [[ $(jq -r .previous.kind <<< "$evidence") == Container ]]; then
      private_file "$directory/previous.json" || refuse
      [[ $(hash "$directory/previous.json") == "$(jq -r .previous.specSha256 <<< "$evidence")" ]] || refuse
    fi
    case $(jq -r .state <<< "$evidence") in
      BackupReady|StartIntent|Healthy)
        [[ $(jq -r .backup.path <<< "$evidence") == "$directory/data.tar" ]] || refuse
        private_file "$directory/data.tar" || refuse
        [[ $(hash "$directory/data.tar") == "$(jq -r .backup.sha256 <<< "$evidence")" ]] || refuse
        ;;
    esac
    if [[ $state == Healthy ]]; then current=$(jq -r .candidate "$journal"); fi
  fi
}
if [[ -e $appdata ]]; then
  private_directory "$appdata" || refuse
  private_file "$appdata/installation.json" || refuse
  jq -e --arg installation "$installation" --arg path "$appdata" --arg target "$target_hash" --arg network "$network_id" '
    . == {version:1,installation:$installation,appdata:$path,targetSha256:$target,networkId:$network}' "$appdata/installation.json" >/dev/null || refuse
  private_directory "$appdata/operations" || refuse
  [[ -d $appdata/data && ! -L $appdata/data && $(stat -c '%u:%g:%a' "$appdata/data") == 1000:1000:700 ]] || refuse
  validate_journal
fi
if [[ $command == status ]]; then
  observations='[]'
  ids=$(docker ps -aq --filter "label=io.hotplate.installation=$installation")
  for id in $ids; do
    observed=$(docker inspect "$id" | jq -ce '.[0] | {id:.Id,running:.State.Running,health:(.State.Health.Status // "none"),restartPolicy:.HostConfig.RestartPolicy.Name}')
    observations=$(jq -c --argjson observed "$observed" '. + [$observed]' <<< "$observations")
  done
  effective=RecoveryRequired
  if [[ $state == Ready && $observations == '[]' ]]; then effective=Ready; fi
  if [[ $state == Healthy ]] && jq -e --arg current "$current" 'any(.[]; .id == $current and .running and .health == "healthy" and .restartPolicy == "unless-stopped")' <<< "$observations" >/dev/null; then effective=Healthy; fi
  jq -cn --arg state "$effective" --arg journalState "$state" --argjson containers "$observations" '{kind:"Result",state:$state,journalState:$journalState,containers:$containers}'
  exit 0
fi
[[ $state == Ready || $state == Healthy ]] || refuse

jq -e '
  .version == 1 and .platform == "linux/amd64" and
  (.revision | test("^[0-9a-f]{40}$")) and (.tag | test("^hotplate-release:[0-9a-f-]{36}$")) and
  (.imageId | test("^sha256:[0-9a-f]{64}$")) and
  (.archiveSha256 | test("^[0-9a-f]{64}$")) and (.controllerSha256 | test("^[0-9a-f]{64}$")) and
  (.archiveBytes | type == "number" and . == floor and . > 0 and . < 21474836480)' <<< "$release" >/dev/null || refuse
if [[ -n ${BASH_EXECUTION_STRING:-} ]]; then
  controller_hash=$(printf '%s\n' "$BASH_EXECUTION_STRING" | sha256sum | cut -d ' ' -f1)
else
  controller_hash=$(hash "$0")
fi
[[ $controller_hash == "$(jq -r .controllerSha256 <<< "$release")" ]] || refuse
aggregate=$(jq -er .secrets.aggregate <<< "$request" | base64 -d)
credentials=$(jq -er .secrets.credentials <<< "$request" | base64 -d)
jq -e --arg origin "$(jq -r .origin <<< "$target")" '. == {databasePath:"/data/aggregate.sqlite",host:"0.0.0.0",port:7345,publicOrigin:$origin,credentialsFile:"/run/secrets/hotplate-credentials.json",trustedHttp:true}' <<< "$aggregate" >/dev/null || refuse
jq -e '.ingest | type == "array" and length > 0' <<< "$credentials" >/dev/null || refuse

inspect_container() { docker inspect "$1" | jq -ce '.[0]'; }
owned_spec() {
  local spec=$1 op image secret_dir
  op=$(jq -er '.Config.Labels["io.hotplate.operation"]' <<< "$spec")
  image=$(jq -er '.Config.Labels["io.hotplate.image"]' <<< "$spec")
  [[ $op =~ ^[0-9a-f-]{36}$ && $image =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  secret_dir=$appdata/operations/$op
  private_directory "$secret_dir" || return 1
  for file in aggregate.json credentials.json; do
    [[ -f $secret_dir/$file && ! -L $secret_dir/$file && $(stat -c '%u:%g:%a:%h' "$secret_dir/$file") == 1000:1000:400:1 ]] || return 1
  done
  jq -e --arg installation "$installation" --arg data "$appdata/data" --arg secrets "$secret_dir" --arg image "$image" '
    .Config.Labels["io.hotplate.installation"] == $installation and .Image == $image and
    .Config.User == "node" and .Config.Entrypoint == ["node","dist/src/cli.js"] and
    .Config.Cmd == ["aggregate","--config","/run/secrets/hotplate.json"] and
    .HostConfig.Privileged == false and .HostConfig.ReadonlyRootfs == true and
    .HostConfig.CapDrop == ["ALL"] and .HostConfig.SecurityOpt == ["no-new-privileges:true"] and
    (.HostConfig.PortBindings | . == null or . == {}) and .HostConfig.PidMode == "" and
    .HostConfig.IpcMode == "private" and .HostConfig.Devices == [] and
    (.Mounts | sort_by(.Destination) | map({Type,Source,Destination,RW})) ==
      ([{Type:"bind",Source:$data,Destination:"/data",RW:true},
        {Type:"bind",Source:($secrets+"/aggregate.json"),Destination:"/run/secrets/hotplate.json",RW:false},
        {Type:"bind",Source:($secrets+"/credentials.json"),Destination:"/run/secrets/hotplate-credentials.json",RW:false}] | sort_by(.Destination))' <<< "$spec" >/dev/null
}
attached() {
  jq -e --arg network "$network" --arg id "$network_id" --arg address "$address" '
    (.NetworkSettings.Networks | keys) == [$network] and
    .NetworkSettings.Networks[$network].NetworkID == $id and
    .NetworkSettings.Networks[$network].IPAMConfig.IPv4Address == $address and
    (if .State.Running then .NetworkSettings.Networks[$network].IPAddress == $address else true end)' <<< "$1" >/dev/null
}
no_writers() {
  local allowed=$1 id spec source rw
  local ids
  ids=$(docker ps -aq) || return 1
  for id in $ids; do
    spec=$(inspect_container "$id") || return 1
    while IFS=$'\t' read -r source rw; do
      source=$(realpath -m "$source") || return 1
      if [[ $source == "$appdata" || $source == "$appdata/"* || $appdata == "$source/"* || $source == / ]]; then
        owned_spec "$spec" || return 1
        if [[ $rw == true && $(jq -r .State.Running <<< "$spec") == true && $(jq -r .Id <<< "$spec") != "$allowed" ]]; then return 1; fi
      fi
    done < <(jq -r '.Mounts[] | [.Source,.RW] | @tsv' <<< "$spec")
  done
}
preflight() {
  local spec
  if [[ -n $current ]]; then
    spec=$(inspect_container "$current")
    owned_spec "$spec" && attached "$spec" || refuse
    jq -e '.State.Running == true and .State.Health.Status == "healthy" and .HostConfig.RestartPolicy == {Name:"unless-stopped",MaximumRetryCount:0}' <<< "$spec" >/dev/null || refuse
    [[ $(jq -r .Image <<< "$spec") == "$(jq -r '.runtimeImageId // .release.imageId' "$journal")" ]] || refuse
    [[ $(jq -r '.Config.Labels["io.hotplate.operation"]' <<< "$spec") == "$(jq -r .operation "$journal")" ]] || refuse
    [[ $(jq -r .Name <<< "$spec") == "/$(jq -r .candidateName "$journal")" ]] || refuse
    local old_secrets=$appdata/operations/$(jq -r .operation "$journal")
    [[ $(printf '%s\n' "$aggregate" | sha256sum | cut -d ' ' -f1) == "$(hash "$old_secrets/aggregate.json")" ]] || refuse
    [[ $(printf '%s\n' "$credentials" | sha256sum | cut -d ' ' -f1) == "$(hash "$old_secrets/credentials.json")" ]] || refuse
  fi
  no_writers "$current" || refuse
  network_info=$(docker network inspect "$network")
  [[ $(jq -r '.[0].Id' <<< "$network_info") == "$network_id" ]] || refuse
  jq -e --arg address "$address" --arg current "$current" '.[0].Containers // {} | to_entries | all(.[]; (.value.IPv4Address | split("/")[0]) != $address or .key == $current)' <<< "$network_info" >/dev/null || refuse
  local bytes data_bytes free docker_root docker_free
  bytes=$(jq -r .archiveBytes <<< "$release")
  data_bytes=0
  [[ ! -d $appdata/data ]] || data_bytes=$(du -sb "$appdata/data" | cut -f1)
  free=$(df -PB1 "$(dirname "$appdata")" | awk 'END {print $4}')
  docker_root=$(docker info --format '{{.DockerRootDir}}')
  docker_free=$(df -PB1 "$docker_root" | awk 'END {print $4}')
  (( free > bytes * 2 + data_bytes * 2 + 1073741824 && docker_free > bytes * 3 + 1073741824 )) || refuse
}
preflight
if [[ $command == plan ]]; then result "$state"; exit 0; fi

if [[ ! -e $appdata ]]; then
  mkdir -m 700 "$appdata"
  jq -cn --arg installation "$installation" --arg path "$appdata" --arg target "$target_hash" --arg network "$network_id" '{version:1,installation:$installation,appdata:$path,targetSha256:$target,networkId:$network}' | atomic "$appdata/installation.json"
  mkdir -m 700 "$appdata/data" "$appdata/operations"
  chown 1000:1000 "$appdata/data"
  jq -cn --arg installation "$installation" '{state:"Ready",installation:$installation}' | atomic "$journal"
fi
opdir=$appdata/operations/$operation
mkdir -m 700 "$opdir"
cp "$journal" "$opdir/before.json"
printf '%s\n' "$release" > "$opdir/release.json"
printf '%s\n' "$aggregate" > "$opdir/aggregate.json"
printf '%s\n' "$credentials" > "$opdir/credentials.json"
chown 1000:1000 "$opdir/aggregate.json" "$opdir/credentials.json"
chmod 400 "$opdir/aggregate.json" "$opdir/credentials.json"
previous='{"kind":"Absent"}'
if [[ -n $current ]]; then
  inspect_container "$current" > "$opdir/previous.json"
  previous=$(jq -cn --arg id "$current" --arg specSha256 "$(hash "$opdir/previous.json")" --arg imageId "$(jq -r .Image "$opdir/previous.json")" --argjson restart "$(jq -c .HostConfig.RestartPolicy "$opdir/previous.json")" '{kind:"Container",id:$id,specSha256:$specSha256,imageId:$imageId,restart:$restart}')
fi
jq -cn --arg installation "$installation" --arg operation "$operation" --argjson release "$release" --argjson previous "$previous" '{state:"Prepared",installation:$installation,operation:$operation,release:$release,previous:$previous}' | atomic "$journal"
transition() { jq --arg state "$1" '.state=$state' "$journal" | atomic "$journal"; }
unchanged_old() {
  [[ $(hash "$opdir/previous.json") == "$(jq -r .previous.specSha256 "$opdir/failure.json")" ]] || return 1
  local spec original normalized
  spec=$(inspect_container "$current") || return 1
  owned_spec "$spec" || return 1
  original=$(jq -cS '[.Id,.Image,.Config,(.HostConfig | del(.RestartPolicy)),.Mounts]' "$opdir/previous.json")
  normalized=$(jq -cS '[.Id,.Image,.Config,(.HostConfig | del(.RestartPolicy)),.Mounts]' <<< "$spec")
  [[ $original == "$normalized" ]] || return 1
  if ! attached "$spec"; then
    [[ $(jq -c '.NetworkSettings.Networks' <<< "$spec") == '{}' ]] || return 1
    docker network connect --ip "$address" "$network_id" "$current" >/dev/null || return 1
  fi
  no_writers "$current" || return 1
  docker update --restart unless-stopped "$current" >/dev/null || return 1
  docker start "$current" >/dev/null || return 1
  local attempt
  for ((attempt=0; attempt<90; attempt++)); do
    spec=$(inspect_container "$current") || return 1
    [[ $(jq -r .State.Running <<< "$spec") == true ]] || return 1
    [[ $(jq -r .State.Health.Status <<< "$spec") != healthy ]] || break
    sleep 2
  done
  owned_spec "$spec" && attached "$spec" || return 1
  jq -e '.State.Running and .State.Health.Status == "healthy" and .HostConfig.RestartPolicy == {Name:"unless-stopped",MaximumRetryCount:0}' <<< "$spec" >/dev/null
}
failed() {
  [[ $BASHPID == $$ ]] || exit 1
  trap - ERR HUP INT TERM
  set +e
  local known_candidate=${candidate:-} failed_evidence failed_state candidate spec
  failed_evidence=$(jq -c . "$journal") || failed_evidence=
  failed_state=Unknown
  if [[ -n $failed_evidence ]]; then failed_state=$(jq -r .state <<< "$failed_evidence") || failed_state=Unknown; fi
  cp "$journal" "$opdir/failure.json" || true
  if [[ -n $failed_evidence ]]; then
    jq -n --arg installation "$installation" --argjson evidence "$failed_evidence" '{state:"RecoveryRequired",installation:$installation,evidence:$evidence}' | atomic "$journal" || true
  fi
  case "$failed_state" in
    Prepared|StopIntent|BackupReady)
      if [[ -n $current ]] && unchanged_old; then cp "$opdir/before.json" "$journal.next" && mv -T "$journal.next" "$journal"; fi
      ;;
    StartIntent|Healthy|Unknown)
      candidate=$known_candidate
      if [[ -z $candidate && -n ${candidate_name:-} ]]; then
        candidate=$(docker ps -aq --filter "name=^/${candidate_name}$") || candidate=
      fi
      if [[ -n $candidate ]]; then
        spec=$(inspect_container "$candidate")
        if owned_spec "$spec" && [[ $(jq -r '.Config.Labels["io.hotplate.operation"]' <<< "$spec") == "$operation" ]]; then
          docker update --restart no "$candidate" >/dev/null && docker stop -t 15 "$candidate" >/dev/null
        fi
      fi
      ;;
  esac
  if [[ $(jq -r .state "$journal") == Healthy ]]; then result Healthy; else result RecoveryRequired; fi
  exit 1
}
trap failed ERR HUP INT TERM
bytes=$(jq -r .archiveBytes <<< "$release")
timeout 600 head -c "$bytes" > "$opdir/image.tar.partial"
[[ $(stat -c %s "$opdir/image.tar.partial") == "$bytes" && $(hash "$opdir/image.tar.partial") == "$(jq -r .archiveSha256 <<< "$release")" ]]
mv "$opdir/image.tar.partial" "$opdir/image.tar"
manifest=$(tar -xOf "$opdir/image.tar" manifest.json)
jq -e --arg tag "$(jq -r .tag <<< "$release")" 'length == 1 and .[0].RepoTags == [$tag] and (.[0].Config | test("^([0-9a-f]{64}\\.json|blobs/sha256/[0-9a-f]{64})$"))' <<< "$manifest" >/dev/null
source_image_id=$(jq -r .imageId <<< "$release")
config_path=$(jq -r '.[0].Config' <<< "$manifest")
config_digest=$(tar -xOf "$opdir/image.tar" "$config_path" | sha256sum | cut -d ' ' -f1)
[[ $config_path == "blobs/sha256/$config_digest" || $config_path == "$config_digest.json" ]]
config_image_id=sha256:$config_digest
if existing=$(docker image inspect "$(jq -r .tag <<< "$release")"); then
  existing_id=$(jq -r '.[0].Id' <<< "$existing")
  [[ $existing_id == "$source_image_id" || $existing_id == "$config_image_id" ]]
fi
timeout 600 docker image load --input "$opdir/image.tar" >/dev/null
image=$(docker image inspect "$(jq -r .tag <<< "$release")")
image_id=$(jq -r '.[0].Id' <<< "$image")
jq -e --arg source "$source_image_id" --arg config "$config_image_id" '.[0] | (.Id == $source or .Id == $config) and .Architecture == "amd64" and .Os == "linux" and .Config.User == "node" and .Config.Healthcheck.Test != null' <<< "$image" >/dev/null
jq --arg image "$image_id" '.runtimeImageId=$image' "$journal" | atomic "$journal"
no_writers "$current"
if [[ -n $current ]]; then
  spec=$(inspect_container "$current")
  owned_spec "$spec"
  attached "$spec"
  [[ $(jq -cS '[.Id,.Image,.Config,.HostConfig,.Mounts]' <<< "$spec") == "$(jq -cS '[.Id,.Image,.Config,.HostConfig,.Mounts]' "$opdir/previous.json")" ]]
  transition StopIntent
  docker update --restart no "$current" >/dev/null
  docker stop -t 15 "$current" >/dev/null
  [[ $(inspect_container "$current" | jq -r .State.Running) == false ]]
fi
no_writers ''
timeout 600 tar -C "$appdata/data" -cpf "$opdir/data.tar.partial" .
tar -tf "$opdir/data.tar.partial" >/dev/null
backup_hash=$(hash "$opdir/data.tar.partial")
mv "$opdir/data.tar.partial" "$opdir/data.tar"
printf '%s  data.tar\n' "$backup_hash" > "$opdir/data.tar.sha256"
(cd "$opdir" && sha256sum -c data.tar.sha256 >/dev/null)
jq --arg path "$opdir/data.tar" --arg sha256 "$backup_hash" '.state="BackupReady" | .backup={path:$path,sha256:$sha256}' "$journal" | atomic "$journal"
if [[ -n $current ]]; then docker network disconnect "$network_id" "$current"; fi
candidate_name=hotplate-$installation-$operation
jq --arg name "$candidate_name" '.state="StartIntent" | .candidateName=$name' "$journal" | atomic "$journal"
candidate=$(docker create --name "$candidate_name" --label "io.hotplate.installation=$installation" --label "io.hotplate.operation=$operation" --label "io.hotplate.image=$image_id" \
  --restart no --read-only --cap-drop ALL --security-opt no-new-privileges:true --stop-timeout 15 \
  --network "$network_id" --ip "$address" \
  --mount "type=bind,source=$appdata/data,target=/data" \
  --mount "type=bind,source=$opdir/aggregate.json,target=/run/secrets/hotplate.json,readonly" \
  --mount "type=bind,source=$opdir/credentials.json,target=/run/secrets/hotplate-credentials.json,readonly" "$image_id")
jq --arg candidate "$candidate" '.candidate=$candidate' "$journal" | atomic "$journal"
owned_spec "$(inspect_container "$candidate")"
docker start "$candidate" >/dev/null
for ((attempt=0; attempt<90; attempt++)); do
  spec=$(inspect_container "$candidate")
  [[ $(jq -r .State.Running <<< "$spec") == true ]]
  health=$(jq -r .State.Health.Status <<< "$spec")
  [[ $health != unhealthy ]]
  [[ $health != healthy ]] || break
  sleep 2
done
[[ $health == healthy ]]
owned_spec "$spec"
attached "$spec"
jq -cn --arg operation "$operation" --arg candidate "$candidate" '{kind:"Probe",operation:$operation,candidate:$candidate}'
IFS= read -r -t 30 acknowledgment
[[ ${#acknowledgment} -le 1024 ]]
jq -e --arg operation "$operation" --arg candidate "$candidate" '. == {operation:$operation,candidate:$candidate}' <<< "$acknowledgment" >/dev/null
spec=$(inspect_container "$candidate")
owned_spec "$spec"
attached "$spec"
jq -e '.State.Running and .State.Health.Status == "healthy"' <<< "$spec" >/dev/null
docker update --restart unless-stopped "$candidate" >/dev/null
jq --arg candidate "$candidate" '.state="Healthy" | .acknowledged=$candidate' "$journal" | atomic "$journal"
result Healthy
trap - ERR HUP INT TERM
